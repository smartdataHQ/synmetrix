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

const ZERO_LITERAL = /^(?:(?:U?Int\d+|Float\d+)_)?0+(?:\.0+)?$/;
const INT_LITERAL = /^(?:U?Int\d+_)?\d+$/;
const DAY_LITERAL = /^'(\d{4}-\d{2}-\d{2})(?:[ T]00:00:00(?:\.000)?Z?)?'$/;
const MONTH_LITERAL = /^'(\d{4}-\d{2}-01)(?:[ T]00:00:00(?:\.000)?Z?)?'$/;
const UTC_LITERAL = /^'UTC'$/i;

const ZERO_ARG_TIME_FUNCTIONS = new Set(["now", "today", "yesterday"]);
const MONTH_TRUNC_FUNCTIONS = new Set(["toStartOfMonth", "toStartOfQuarter", "toStartOfYear"]);
const DAY_TRUNC_FUNCTIONS = new Set(["toStartOfDay", "toDate", ...MONTH_TRUNC_FUNCTIONS]);
const MONTH_SHIFT_FUNCTIONS = new Set([
  "subtractYears", "addYears", "subtractQuarters", "addQuarters", "subtractMonths", "addMonths",
]);
const DAY_SHIFT_FUNCTIONS = new Set(["subtractWeeks", "addWeeks", "subtractDays", "addDays", ...MONTH_SHIFT_FUNCTIONS]);
const MONTH_INTERVAL_FUNCTIONS = new Set(["toIntervalYear", "toIntervalQuarter", "toIntervalMonth"]);
const DAY_INTERVAL_FUNCTIONS = new Set(["toIntervalWeek", "toIntervalDay", ...MONTH_INTERVAL_FUNCTIONS]);
const DATETIME_CAST_FUNCTIONS = new Set(["toDateTime", "toDateTime64", "parseDateTimeBestEffort", "parseDateTime64BestEffort"]);
const DATETIME64_CAST_FUNCTIONS = new Set(["toDateTime64", "parseDateTime64BestEffort"]);

function functionArgs(node) {
  if (node?.type !== "Function") return null;
  const list = node.children[0];
  if (node.children.length > 1 || (list && list.type !== "ExpressionList")) return null;
  return list ? list.children : [];
}

const ZERO_CAST_FUNCTIONS = new Set(["CAST", "_CAST", "cast", "toFloat64", "toFloat32", "toInt64", "toInt32", "toNullable"]);

function isZeroOrNullLiteral(node) {
  if (!node) return false;
  if (node.type === "Literal") {
    return node.name === "NULL" || ZERO_LITERAL.test(String(node.name ?? ""));
  }
  const args = functionArgs(node);
  if (args && ZERO_CAST_FUNCTIONS.has(node.name) && args.length >= 1 && args.length <= 2) {
    return isZeroOrNullLiteral(args[0]);
  }
  return false;
}

function isIntegerLiteral(node) {
  return node?.type === "Literal" && INT_LITERAL.test(String(node.name ?? ""));
}

/** True when a ClickHouse date/time expression has no table column references and no non-UTC timezone arg. */
function isConstantTimeExpr(node) {
  if (!node) return false;
  if (node.type === "Literal") return true;
  const args = functionArgs(node);
  if (!args) return false;
  if (ZERO_ARG_TIME_FUNCTIONS.has(node.name)) {
    return args.length === 0 || (node.name === "now" && args.length === 1 && UTC_LITERAL.test(String(args[0]?.name ?? "")));
  }
  if (DAY_TRUNC_FUNCTIONS.has(node.name)) {
    if (args.length === 2 && !UTC_LITERAL.test(String(args[1]?.name ?? ""))) return false;
    return (args.length === 1 || args.length === 2) && isConstantTimeExpr(args[0]);
  }
  if (DAY_SHIFT_FUNCTIONS.has(node.name)) {
    return args.length === 2 && isConstantTimeExpr(args[0]) && isIntegerLiteral(args[1]);
  }
  if (DAY_INTERVAL_FUNCTIONS.has(node.name)) {
    return args.length === 1 && isIntegerLiteral(args[0]);
  }
  if (DATETIME_CAST_FUNCTIONS.has(node.name)) {
    if (DATETIME64_CAST_FUNCTIONS.has(node.name)) {
      if (args.length === 3 && !UTC_LITERAL.test(String(args[2]?.name ?? ""))) return false;
      return (args.length === 2 || args.length === 3) && isConstantTimeExpr(args[0]) && isIntegerLiteral(args[1]);
    }
    if (args.length === 2 && !UTC_LITERAL.test(String(args[1]?.name ?? ""))) return false;
    return (args.length === 1 || args.length === 2) && isConstantTimeExpr(args[0]);
  }
  if (node.name === "plus" || node.name === "minus") {
    return args.length === 2 && isConstantTimeExpr(args[0]) && isConstantTimeExpr(args[1]);
  }
  return false;
}

/**
 * True when `node` evaluates to a query-constant UTC timestamp aligned to `grain`'s
 * bucket boundaries, so `timestamp >= bound` and `timestamp < bound` are constant
 * across every raw row merged into a bucket of `grain`.
 */
function isAlignedTimeBound(node, grain) {
  if (!node || !grain) return false;
  const isMonth = grain.grainKind === "month" || grain.grain === "1 month";
  const isDayOrFiner = !isMonth && Number.isFinite(grain.grainSeconds) && grain.grainSeconds > 0 && 86400 % grain.grainSeconds === 0;
  if (!isMonth && !isDayOrFiner) return false;

  if (node.type === "Literal") {
    const match = (isMonth ? MONTH_LITERAL : DAY_LITERAL).exec(String(node.name ?? ""));
    return Boolean(match && !Number.isNaN(Date.parse(`${match[1]}T00:00:00.000Z`)));
  }

  const args = functionArgs(node);
  if (!args) return false;
  if (node.name === "today" || node.name === "yesterday") {
    return isDayOrFiner && args.length === 0;
  }
  if (MONTH_TRUNC_FUNCTIONS.has(node.name)) {
    if (args.length === 2 && !UTC_LITERAL.test(String(args[1]?.name ?? ""))) return false;
    return (args.length === 1 || args.length === 2) && isConstantTimeExpr(args[0]);
  }
  if (node.name === "toStartOfDay" || node.name === "toDate") {
    if (args.length === 2 && !UTC_LITERAL.test(String(args[1]?.name ?? ""))) return false;
    if (args.length !== 1 && args.length !== 2) return false;
    return isDayOrFiner ? isConstantTimeExpr(args[0]) : isAlignedTimeBound(args[0], grain);
  }
  if (DATETIME_CAST_FUNCTIONS.has(node.name)) {
    if (DATETIME64_CAST_FUNCTIONS.has(node.name)) {
      if (args.length === 3 && !UTC_LITERAL.test(String(args[2]?.name ?? ""))) return false;
      return (args.length === 2 || args.length === 3) && isAlignedTimeBound(args[0], grain) && isIntegerLiteral(args[1]);
    }
    if (args.length === 2 && !UTC_LITERAL.test(String(args[1]?.name ?? ""))) return false;
    return (args.length === 1 || args.length === 2) && isAlignedTimeBound(args[0], grain);
  }
  if ((isMonth ? MONTH_SHIFT_FUNCTIONS : DAY_SHIFT_FUNCTIONS).has(node.name)) {
    return args.length === 2 && isAlignedTimeBound(args[0], grain) && isIntegerLiteral(args[1]);
  }
  if ((node.name === "plus" || node.name === "minus") && args.length === 2) {
    const intervalArgs = functionArgs(args[1]);
    const allowedIntervals = isMonth ? MONTH_INTERVAL_FUNCTIONS : DAY_INTERVAL_FUNCTIONS;
    return (
      isAlignedTimeBound(args[0], grain) &&
      Boolean(intervalArgs && allowedIntervals.has(args[1].name) && intervalArgs.length === 1 && isIntegerLiteral(intervalArgs[0]))
    );
  }
  return false;
}

function walk(node, columns, grain) {
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

  // Bucket-invariant half-open time comparisons (`T >= B` or `T < B`, and their
  // symmetric forms `B <= T` / `B > T`) evaluate identically for every raw row
  // inside a bucket of `grain`. `T <= B` and `T > B` are intentionally excluded
  // because they split the bucket at its exact boundary timestamp `00:00:00.000`.
  if (grain && args.length === 2) {
    const isTimeId = (candidate) => candidate?.type === "Identifier" && columns.get(candidate.name) === "T";
    if ((node.name === "greaterOrEquals" || node.name === "less") && isTimeId(args[0]) && isAlignedTimeBound(args[1], grain)) {
      return K;
    }
    if ((node.name === "lessOrEquals" || node.name === "greater") && isAlignedTimeBound(args[0], grain) && isTimeId(args[1])) {
      return K;
    }
  }

  const classes = args.map((arg) => walk(arg, columns, grain));
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
    case "if":
      // `if(cond, thenVal, elseVal)` is exact when summed iff `cond` is constant per
      // bucket (`K`) and every branch is either linear summed (`S`) or 0 / NULL
      // (a non-zero constant would be summed once per aggregate row instead of per raw row).
      if (
        args.length === 3 &&
        classes[0] === K &&
        (classes[1] === S || isZeroOrNullLiteral(args[1])) &&
        (classes[2] === S || isZeroOrNullLiteral(args[2])) &&
        (classes[1] === S || classes[2] === S)
      ) {
        return S;
      }
      break;
    case "multiIf":
      // ClickHouse parses `CASE WHEN c1 THEN v1 ... [ELSE vN] END` into `multiIf`.
      if (args.length >= 3 && args.length % 2 === 1) {
        let allConditionsK = true;
        let allValuesSumOrZero = true;
        let hasSumValue = false;
        for (let i = 0; i < args.length - 1; i += 2) {
          if (classes[i] !== K) allConditionsK = false;
          if (classes[i + 1] === S) hasSumValue = true;
          else if (!isZeroOrNullLiteral(args[i + 1])) allValuesSumOrZero = false;
        }
        const elseIdx = args.length - 1;
        if (classes[elseIdx] === S) hasSumValue = true;
        else if (!isZeroOrNullLiteral(args[elseIdx])) allValuesSumOrZero = false;
        if (allConditionsK && allValuesSumOrZero && hasSumValue) return S;
      }
      break;
    default:
  }
  return x("not_exact_when_summed");
}

/** Class of one parsed expression. `columns` maps a column name to K, S, M (summed map), T (time) or X. */
export function classify(node, columns, grain = null) {
  const result = walk(node, columns, grain);
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
