/**
 * semanticEvents — focused, never-throw semantic-event emitter for the ACTIONS
 * webhook service (099 Semantic Events, FR-091). Hasura event-trigger handlers
 * use it to emit lifecycle events (Model Version Created / Branch Created-Deleted
 * / access-control) to the FraiOS ingress. Mirrors the canonical contract of
 * services/cubejs/src/utils/eventEmitter.js (kept minimal: synmetrix ids are
 * UUIDs, so entity_gid is passthrough and no FNV hash is needed here).
 *
 * Emission is best-effort + fire-and-forget: it NEVER throws (FR-007) and never
 * blocks the webhook response. The ingress derives the tenant partition from the
 * OWNED_BY account gid (entity_gid), so `accountId` alone attributes correctly.
 */
import crypto from "crypto";
import { SignJWT } from "jose";
// Native global fetch (Node 20+) — same choice as utils/graphql.js, avoids the
// node-fetch socket-hang-up issues.

const { TOKEN_SECRET, INGRESSION_HOST, CXS_EVENT_SOURCE } = process.env;
const DEFAULT_SOURCE = "synmetrix";
const ID_TYPE = "FraiOS";
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** RFC-4122 v5 (SHA-1) uuid — matches the `uuid` package's v5 used by cubejs. */
function uuid5(name, namespace = DNS_NAMESPACE) {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = crypto
    .createHash("sha1")
    .update(nsBytes)
    .update(String(name), "utf8")
    .digest();
  const b = hash.subarray(0, 16);
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(
    16,
    20
  )}-${h.slice(20)}`;
}

/** Deterministic, replay-stable message_id from stable parts joined by ":". */
export function messageIdFor(...parts) {
  return uuid5(parts.map((p) => String(p ?? "")).join(":"));
}

/** entity_gid: RFC-4122 passthrough (synmetrix ids are UUIDs), else uuid5. */
function normalizeEntityGid(raw) {
  const s = String(raw ?? "");
  return UUID_REGEX.test(s) ? s : uuid5(s);
}

/** One involve entry (fraios id model). */
function involve(role, entity_type, value, label) {
  const entry = { role, entity_type, entity_gid: normalizeEntityGid(value), id_type: ID_TYPE };
  const s = String(value ?? "");
  if (s && !UUID_REGEX.test(s)) entry.id = s;
  if (label) entry.label = label;
  return entry;
}

/**
 * Build a canonical lifecycle envelope: OWNED_BY/Account (+ ACTED_BY/Person when
 * a human is attributable) + an optional ABOUT subject. Emitted `type: "track"`.
 */
export function buildLifecycleEvent({
  event,
  partition = null, // team.settings.partition — the canonical tenant key
  accountId = null, // the owning team (synmetrix's account-equivalent) id
  accountLabel = null,
  userId = null,
  about = null, // { entity_type, id, label }
  status = "ok",
  dimensions = null,
  properties = null,
  timestamp = null,
} = {}) {
  const ts = timestamp || new Date().toISOString();
  const ownerId = String(accountId ?? partition ?? "");
  const aboutId = about && about.id != null && String(about.id) !== "" ? String(about.id) : null;
  const entityGid = aboutId || ownerId;
  const message_id = messageIdFor(event, partition ?? "", ownerId, aboutId ?? "", status, ts);

  const involves = [involve("OWNED_BY", "Account", ownerId, accountLabel)];
  if (userId) involves.push(involve("ACTED_BY", "Person", String(userId)));
  if (aboutId && about.entity_type) {
    involves.push(involve("ABOUT", String(about.entity_type), aboutId, about.label));
  }

  const source = (CXS_EVENT_SOURCE || "").trim() || DEFAULT_SOURCE;
  const env = process.env.KUBERNETES_SERVICE_HOST ? "cluster" : "local";
  return {
    type: "track",
    event,
    abstract_event: event,
    message_id,
    event_gid: uuid5(message_id.toLowerCase()),
    timestamp: ts,
    // The tenant key. partition == the synmetrix team (team.settings.partition),
    // the same key the semantic_events RLS filters on. Fall back to the ingress
    // account-derived partition only when a partition was not resolved.
    partition: partition ? String(partition) : "",
    entity_gid: normalizeEntityGid(entityGid),
    customer_facing: 0,
    source,
    dimensions: { status, ...(dimensions || {}), environment: env },
    involves,
    properties: { ...(properties || {}) },
  };
}

async function mintServiceToken({ accountId = null, partition = null } = {}) {
  if (!TOKEN_SECRET || (!accountId && !partition)) return null;
  try {
    const claims = { provider: "synmetrix" };
    if (accountId != null) claims.accountId = String(accountId);
    if (partition != null) claims.partition = String(partition);
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("services:actions")
      .setAudience("fraios:ingression")
      .setExpirationTime("5m")
      .sign(new TextEncoder().encode(TOKEN_SECRET));
  } catch {
    return null;
  }
}

/**
 * Best-effort, never-throw POST of a lifecycle event to the ingress. Attributes
 * the tenant via `partition` (== the owning team; the canonical key) and/or
 * `accountId`. Skips silently when no tenant or no ingress/secret is configured
 * (A4 — a credential is never invented).
 */
export async function emitLifecycleEvent(args = {}) {
  try {
    const { accountId = null, partition = null } = args;
    if ((!accountId && !partition) || !INGRESSION_HOST) {
      return { ok: false, skipped: true };
    }
    const envelope = buildLifecycleEvent(args);
    const writekey = await mintServiceToken({ accountId, partition });
    if (!writekey) return { ok: false, skipped: true };
    const url = `${INGRESSION_HOST}/api/s/${envelope.type || "track"}`;
    // Bounded so a slow/hung ingress can never stall a caller (a Hasura trigger
    // handler or an admin RPC). On timeout the POST aborts and we return not-ok —
    // emission is best-effort and never blocks the operation (FR-007).
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", writekey },
        body: JSON.stringify(envelope),
        signal: ctrl.signal,
      });
      return { ok: res.ok, status: res.status };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false }; // FR-007: never throw into the webhook handler
  }
}
