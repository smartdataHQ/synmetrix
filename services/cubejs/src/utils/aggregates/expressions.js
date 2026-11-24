/**
 * Decides whether an expression gives the same result on aggregate rows as on
 * source rows. ClickHouse parses the expression (`EXPLAIN AST`, nothing is
 * executed); this module walks the tree. The account must be allowed to read
 * EXPLAIN through a SELECT, which a `readonly = 1` account is not.
 *
 *   K  reads grouping columns only: the same on both tables
 *   S  exact when summed: linear in exactly one summed value
 *   X  not provably exact
 */
import { IDENTIFIER } from "./contract.js";

const K = Object.freeze({ cls: "K" });
const S = Object.freeze({ cls: "S" });
const M = Object.freeze({ cls: "M" }); // a summed map: exact only through one key
const x = (detail) => ({ cls: "X", detail });
const UNSUPPORTED = Object.freeze(x("unsupported_member"));

// Their result depends on which rows are read and in what order.
const ROW_ORDER_FUNCTIONS = new Set([
  "runningDifference", "runningDifferenceStartingWithFirstValue", "runningAccumulate", "runningConcurrency",
  "neighbor", "rowNumberInBlock", "rowNumberInAllBlocks", "blockNumber", "blockSize", "nonNegativeDerivative",
]);

/** The tree of an `EXPLAIN AST` dump: one node per line, depth by indentation. */
export function parseAst(text) {
  const root = { type: "Root", children: [] };
  const stack = [root];
  for (const line of String(text).split("\n")) {
    if (!line.trim()) continue;
    const depth = line.length - line.trimStart().length;
    const [, type, rest = ""] = /^(\S+)(?: (.*))?$/.exec(line.trim());
    const node = { type, children: [] };
    let name = rest.replace(/ \(children \d+\)$/, "");
    const alias = / \(alias ([^)]*)\)$/.exec(name);
    if (alias) {
      node.alias = alias[1];
      name = name.slice(0, alias.index);
    }
    if (name) node.name = name;
    if (depth + 1 > stack.length) throw new Error("unexpected indentation in the parse tree");
    stack.length = depth + 1;
    stack[depth].children.push(node);
    stack.push(node);
  }
  if (root.children.length !== 1) throw new Error("the parse tree has no single root");
  return root.children[0];
}

function walk(node, columns) {
  if (node.type === "Literal") return K;
  if (node.type === "Identifier") {
    const cls = columns.get(node.name);
    if (cls === "K") return K;
    if (cls === "S") return S;
    if (cls === "M") return M;
    return x(cls === "T" ? "reads_time_column" : "column_not_in_aggregate");
  }
  if (node.type !== "Function") return UNSUPPORTED;
  const list = node.children[0];
  if (node.children.length > 1 || (list && list.type !== "ExpressionList")) return UNSUPPORTED;
  if (ROW_ORDER_FUNCTIONS.has(node.name)) return UNSUPPORTED;

  const args = list ? list.children : [];
  const classes = args.map((arg) => walk(arg, columns));
  const unsafe = classes.find((result) => result.cls === "X");
  if (unsafe) return unsafe;
  if (classes.every((result) => result === K)) return K;

  const count = (wanted) => classes.filter((result) => result === wanted).length;
  const sums = count(S);
  const is = (...shape) => shape.length === classes.length && shape.every((cls, i) => classes[i] === cls);
  switch (node.name) {
    case "arrayElement":
      if (is(M, K)) return S;
      break;
    case "multiply":
      if (sums === 1 && count(M) === 0) return S;
      break;
    case "divide":
      if (is(S, K)) return S;
      break;
    case "plus":
    case "minus":
      if (sums === classes.length) return S;
      break;
    case "negate":
    case "toFloat64":
      if (is(S)) return S;
      break;
    case "CAST":
    case "cast":
      if (is(S, K) && args[1].type === "Literal" && args[1].name === "'Float64'") return S;
      break;
    default:
  }
  return x("not_exact_when_summed");
}

/** Class of one parsed expression. `columns` maps a column name to K, S, M (summed map), T (time) or X. */
export function classify(node, columns) {
  const result = walk(node, columns);
  return result === M ? x("not_exact_when_summed") : result;
}

export const JOINED_KEY_PLACEHOLDER = "__agg_joined_k__";

/**
 * A cube member's SQL as a plain expression: `{CUBE}.col` becomes `col`, and a
 * reference to another dimension of the cube is replaced by that dimension's
 * expression. When `joinedCubes` is provided, references to a kept many_to_one
 * / one_to_one joined cube (`{other.member}` or `{other}.col`) become a K-class
 * placeholder so the surrounding expression can still be parsed and checked.
 * Any other template form has no fixed meaning here: null.
 */
export function memberExpression(sql, cube, seen = new Set(), joinedCubes = null) {
  if (typeof sql !== "string") return null;
  let failed = false;
  const resolved = sql.replace(/\{([^{}]*)\}(?:\.([A-Za-z_][A-Za-z0-9_]*))?/g, (whole, inner, dotIdent) => {
    const reference = inner.trim();
    if (reference === "CUBE" || reference === cube.name) {
      if (dotIdent) return dotIdent;
      failed = true;
      return whole;
    }
    if (joinedCubes?.size) {
      // `{bonus_products}.product_id`
      if (dotIdent && joinedCubes.has(reference)) return JOINED_KEY_PLACEHOLDER;
      // `{bonus_products.supplier}`
      const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(reference);
      if (!dotIdent && dotted && joinedCubes.has(dotted[1])) return JOINED_KEY_PLACEHOLDER;
    }
    const name = reference.replace(new RegExp(`^(CUBE|${cube.name})\\.`), "");
    const dimension = (cube.dimensions || []).find((candidate) => candidate.name === name);
    const expression =
      !dotIdent && IDENTIFIER.test(name) && dimension && !dimension.case && !seen.has(name)
        ? memberExpression(dimension.sql, cube, new Set([...seen, name]), joinedCubes)
        : null;
    if (expression === null) {
      failed = true;
      return whole;
    }
    return `(${expression})`;
  });
  return failed || /[{}]/.test(resolved) ? null : resolved;
}

/**
 * Classifies many expressions with one statement. An entry that is null, empty
 * or still holds a template is not sent and is unsupported.
 *
 * @param {(sql: string) => Promise<Array<{explain: string}>>} queryFn
 * @returns {Promise<Array<{cls: string, detail?: string, node?: object}>>} aligned with `expressions`
 */
export async function classifyBatch(queryFn, expressions, columns, { directExplain = false } = {}) {
  const results = expressions.map(() => UNSUPPORTED);
  const sent = [];
  expressions.forEach((expression, index) => {
    if (typeof expression === "string" && expression.trim() && !/[{}]/.test(expression)) sent.push(index);
  });
  if (sent.length === 0) return results;

  // Each expression on its own lines, so a trailing line comment cannot swallow the next one.
  // When the caller runs `client.exec()` with `X-ClickHouse-Format: JSON` (`directExplain: true`),
  // ClickHouse executes `EXPLAIN AST` directly without needing `CREATE TEMPORARY TABLE` (required
  // by ClickHouse 26.10 for `FROM (EXPLAIN ...)`). Otherwise wrap in a SELECT so drivers that
  // append `FORMAT JSON` to the SQL string apply it to the EXPLAIN answer rather than the inner query.
  const explain = `EXPLAIN AST SELECT ${sent.map((index) => `tuple(\n${expressions[index]}\n)`).join(", ")}`;
  const sql = directExplain ? explain : `SELECT explain FROM (${explain})`;
  const rows = await queryFn(sql);
  const roots = expressionRoots(parseAst(rows.map((row) => row.explain).join("\n")), sent.length);
  sent.forEach((index, position) => {
    const parts = roots[position];
    if (parts.length === 1) results[index] = { ...classify(parts[0], columns), node: parts[0] };
  });
  return results;
}

// SELECT tuple(e1), tuple(e2), … and nothing else: no second statement, and no
// table other than the `system.one` ClickHouse itself adds to a SELECT without FROM.
function expressionRoots(root, expected) {
  const fail = () => {
    throw new Error("the statement did not parse as a plain list of expressions");
  };
  const only = (node, type) => {
    if (!node || node.type !== type || node.children.length !== 1) fail();
    return node.children[0];
  };
  const query = only(only(root, "SelectWithUnionQuery"), "ExpressionList");
  if (query.type !== "SelectQuery" || query.children.length < 1 || query.children.length > 2) fail();
  const [select, tables] = query.children;
  if (tables) {
    const table = only(only(only(tables, "TablesInSelectQuery"), "TablesInSelectQueryElement"), "TableExpression");
    if (table.type !== "TableIdentifier" || table.name !== "system.one" || table.children.length) fail();
  }
  if (select.type !== "ExpressionList" || select.children.length !== expected) fail();
  return select.children.map((node) => {
    if (node.type !== "Function" || node.name !== "tuple") fail();
    return node.children[0] ? node.children[0].children : [];
  });
}
