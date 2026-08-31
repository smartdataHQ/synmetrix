export const LEGACY_ENRICHMENT_CUBES = new Set([
  "CtxDayContext",
  "CtxWeatherContext",
]);

const MEMBER_KEYS = new Set(["member", "dimension", "id"]);
const QUERY_MEMBER_ARRAYS = [
  "dimensions",
  "measures",
  "segments",
  "timeDimensions",
  "filters",
];

function unavailableError() {
  const error = new Error("403: Requested data is not available");
  error.status = 403;
  error.code = "enrichment_not_available";
  return error;
}

function addMember(target, value) {
  if (typeof value === "string" && value.includes(".")) target.add(value);
}

function walkMemberNode(node, target) {
  if (typeof node === "string") {
    addMember(target, node);
    return;
  }
  if (Array.isArray(node)) {
    for (const value of node) walkMemberNode(value, target);
    return;
  }
  if (!node || typeof node !== "object") return;

  for (const [key, value] of Object.entries(node)) {
    if (MEMBER_KEYS.has(key)) addMember(target, value);
    if (key === "and" || key === "or" || key === "filters") {
      walkMemberNode(value, target);
    }
  }
}

function walkOrder(order, target) {
  if (!order) return;
  if (typeof order === "string") {
    addMember(target, order);
    return;
  }
  if (Array.isArray(order)) {
    for (const entry of order) {
      if (Array.isArray(entry)) {
        addMember(target, entry[0]);
      } else {
        walkMemberNode(entry, target);
      }
    }
    return;
  }
  if (typeof order === "object") {
    if (typeof order.id === "string" || typeof order.member === "string") {
      walkMemberNode(order, target);
      return;
    }
    for (const key of Object.keys(order)) addMember(target, key);
  }
}

export function collectResolvedMembers(query) {
  const members = new Set();
  for (const key of QUERY_MEMBER_ARRAYS) walkMemberNode(query?.[key], members);
  walkOrder(query?.order, members);
  return [...members];
}

export function queryUsesLegacyEnrichment(query) {
  return collectResolvedMembers(query).some((member) =>
    LEGACY_ENRICHMENT_CUBES.has(member.split(".", 1)[0]),
  );
}

export function assertNoLegacyEnrichmentQuery(query) {
  if (queryUsesLegacyEnrichment(query)) throw unavailableError();
}

function tokenizeSql(sql) {
  const tokens = [];
  const text = String(sql || "");
  let index = 0;
  const identifierStart = /[A-Za-z_$]/;
  const identifierPart = /[A-Za-z0-9_$-]/;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "-" && next === "-") {
      index += 2;
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      let depth = 1;
      while (index < text.length && depth > 0) {
        if (text[index] === "/" && text[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (text[index] === "*" && text[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (char === "'") {
      index += 1;
      while (index < text.length) {
        if (text[index] === "'" && text[index + 1] === "'") {
          index += 2;
        } else if (text[index] === "'") {
          index += 1;
          break;
        } else if (text[index] === "\\") {
          index += 2;
        } else {
          index += 1;
        }
      }
      continue;
    }
    if (char === '"' || char === "`" || char === "[") {
      const close = char === "[" ? "]" : char;
      let value = "";
      index += 1;
      while (index < text.length) {
        if (text[index] === close && text[index + 1] === close) {
          value += close;
          index += 2;
        } else if (text[index] === close) {
          index += 1;
          break;
        } else {
          value += text[index];
          index += 1;
        }
      }
      tokens.push({ type: "identifier", value });
      continue;
    }
    if (identifierStart.test(char)) {
      let value = char;
      index += 1;
      while (index < text.length && identifierPart.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ type: "identifier", value });
      continue;
    }
    if (".,()".includes(char)) tokens.push({ type: char, value: char });
    index += 1;
  }
  return tokens;
}

function identifierAt(tokens, index) {
  if (tokens[index]?.type !== "identifier") return null;
  const parts = [tokens[index].value];
  let cursor = index + 1;
  while (
    tokens[cursor]?.type === "." &&
    tokens[cursor + 1]?.type === "identifier"
  ) {
    parts.push(tokens[cursor + 1].value);
    cursor += 2;
  }
  return { parts, next: cursor };
}

export function parseSqlTableReferences(sql) {
  const tokens = tokenizeSql(sql);
  const references = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const keyword = tokens[index]?.value?.toLowerCase();
    if (!["from", "join", "update", "into", "table"].includes(keyword))
      continue;
    const parsed = identifierAt(tokens, index + 1);
    if (!parsed || tokens[parsed.next]?.type === "(") continue;
    const normalized = parsed.parts.map((part) => part.toLowerCase());
    references.push({
      schema: normalized.length > 1 ? normalized.at(-2) : null,
      table: normalized.at(-1),
    });
  }
  return references;
}

export function assertNoLegacyEnrichmentSql(sql) {
  const enrichmentRefs = parseSqlTableReferences(sql).filter(
    (reference) => reference.schema === "enrich",
  );
  if (enrichmentRefs.length > 0) throw unavailableError();
}

export function assertNoDirectLegacyEnrichmentObject(schema, table) {
  const schemaName = String(schema || "")
    .replace(/^[`"[]|[`"\]]$/g, "")
    .toLowerCase();
  const qualified = String(table || "")
    .replace(/[`"\[\]]/g, "")
    .toLowerCase();
  if (
    schemaName === "enrich" ||
    qualified === "enrich" ||
    qualified.startsWith("enrich.")
  ) {
    throw unavailableError();
  }
}

export function removeLegacyEnrichmentSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([name]) => name.toLowerCase() !== "enrich"),
  );
}
