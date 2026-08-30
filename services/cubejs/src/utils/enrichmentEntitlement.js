import { createHmac, timingSafeEqual } from "node:crypto";

export const ENRICHMENT_PRODUCTS = [
  "ctx:day-archetype",
  "ctx:weather-archetype",
];
export const ENRICHMENT_CUBES = new Set(["CtxDayContext", "CtxWeatherContext"]);
export const ENRICHMENT_SERVING_TABLES = new Set([
  "day_context_v",
  "weather_context_v",
]);

const MEMBER_KEYS = new Set(["member", "dimension", "id"]);
const QUERY_MEMBER_ARRAYS = [
  "dimensions",
  "measures",
  "segments",
  "timeDimensions",
  "filters",
];

const canonicalPayload = (payload) =>
  JSON.stringify({
    schema_version: payload.schema_version,
    account_partition: payload.account_partition,
    enabled: payload.enabled,
    entitlement_revision: payload.entitlement_revision,
    issued_at: payload.issued_at,
    valid_until: payload.valid_until,
    products: payload.products,
  });

function signaturesMatch(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

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

export function queryUsesEnrichment(query) {
  return collectResolvedMembers(query).some((member) =>
    ENRICHMENT_CUBES.has(member.split(".", 1)[0]),
  );
}

export function validateEnrichmentLease(
  securityContext,
  {
    signingKey = process.env.ENRICHMENT_ENTITLEMENT_SIGNING_KEY,
    now = new Date(),
  } = {},
) {
  const teamSettings = securityContext?.userScope?.teamProperties;
  const partition = teamSettings?.partition;
  const lease = teamSettings?.premium?.enrichment;
  if (!partition || !signingKey || !lease) return { valid: false };

  const issuedAt = Date.parse(lease.issued_at);
  const validUntil = Date.parse(lease.valid_until);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (
    lease.signature_version !== "hmac-sha256-v1" ||
    lease.enabled !== true ||
    typeof lease.entitlement_revision !== "string" ||
    !Array.isArray(lease.products) ||
    lease.products.join(",") !== ENRICHMENT_PRODUCTS.join(",") ||
    !Number.isFinite(issuedAt) ||
    !Number.isFinite(validUntil) ||
    !Number.isFinite(nowMs) ||
    issuedAt > nowMs ||
    validUntil <= nowMs
  ) {
    return { valid: false };
  }

  const payload = {
    schema_version: 1,
    account_partition: partition,
    enabled: lease.enabled,
    entitlement_revision: lease.entitlement_revision,
    issued_at: lease.issued_at,
    valid_until: lease.valid_until,
    products: lease.products,
  };
  const expected = createHmac("sha256", signingKey)
    .update(canonicalPayload(payload))
    .digest("base64url");
  return { valid: signaturesMatch(expected, lease.signature) };
}

export function assertEnrichmentQueryAuthorized(
  query,
  securityContext,
  options,
) {
  if (!queryUsesEnrichment(query)) return;
  if (!validateEnrichmentLease(securityContext, options).valid) {
    throw unavailableError();
  }
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

export function sqlEnrichmentBillingItems(sql) {
  const items = new Set();
  for (const reference of parseSqlTableReferences(sql)) {
    if (reference.schema !== "enrich") continue;
    if (reference.table === "day_context_v") items.add("ctx:day-archetype");
    if (reference.table === "weather_context_v") {
      items.add("ctx:weather-archetype");
    }
  }
  return ENRICHMENT_PRODUCTS.filter((item) => items.has(item));
}

export function assertSqlEnrichmentAuthorized(sql, securityContext, options) {
  const enrichmentRefs = parseSqlTableReferences(sql).filter(
    (reference) => reference.schema === "enrich",
  );
  if (enrichmentRefs.length === 0) return;
  if (
    enrichmentRefs.some(
      (reference) => !ENRICHMENT_SERVING_TABLES.has(reference.table),
    ) ||
    !validateEnrichmentLease(securityContext, options).valid
  ) {
    throw unavailableError();
  }
}

export function assertNoDirectEnrichmentObject(schema, table) {
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

export function removeEnrichmentSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema))
    return schema;
  return Object.fromEntries(
    Object.entries(schema).filter(([name]) => name.toLowerCase() !== "enrich"),
  );
}
