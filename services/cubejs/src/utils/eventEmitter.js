import fetch from "node-fetch";
import { SignJWT } from "jose";
import { v5 as uuidv5 } from "uuid";
import { hostname } from "os";

/**
 * eventEmitter — never-throw, fire-and-forget semantic-event emitter for
 * synmetrix (099 T086, FR-091). This is the SUBSTRATE only: it builds canonical
 * envelopes and POSTs them to the FraiOS ingression endpoint. It is NOT yet
 * wired into any handler — that is T087–T090 (llmEnricher / modelAdvisor emit
 * `Connection Called` per OpenAI call).
 *
 * Contract mirror: modelled on `auditWriter.js` — best-effort with N attempts +
 * exponential backoff, and NEVER throws / never blocks the caller's response
 * (FR-007). Every failure branch drops a single structured stderr line as a
 * last-resort observation and returns `{ ok: false }`.
 *
 * Credential (FR-074 / A4): synmetrix is a background/service caller. If the
 * caller forwards its own token (`emitSemanticEvent(env, { token })`) that is
 * used verbatim as the ingression `writekey`. Otherwise a short-lived
 * FraiOS-shaped service token is minted from the shared `TOKEN_SECRET`
 * (HS256 via `jose`, mirroring `mintHasuraToken.js`) so the record still bills
 * to the operating tenant. A credential is never invented to fill a gap: with
 * no forwarded token and no `TOKEN_SECRET`, the event is skipped + counted.
 *
 * Endpoint: `{INGRESSION_HOST}/api/s/{envelope.type||'log'}` — `INGRESSION_HOST`
 * defaults to the FraiOS inbox (matches ai-service `config.py`).
 */

const { TOKEN_SECRET, INGRESSION_HOST, CXS_EVENT_SOURCE, CXS_ENVIRONMENT } =
  process.env;

// Retry policy — mirrors auditWriter.js (3 attempts, 50ms initial backoff).
const MAX_ATTEMPTS = 3;
const INITIAL_BACKOFF_MS = 50;

// FraiOS inbox default (parity with ai-service `INGRESSION_HOST`).
const DEFAULT_INGRESSION_HOST = "https://inbox.fraios.dev";

// Short-lived minted service token (minutes) + its provider marker so the
// ingression side can attribute the writer.
const SERVICE_TOKEN_TTL_MIN = 5;
const SERVICE_PROVIDER = "synmetrix-service";

// Origin tagging — the shared vocabulary tags `source` = producer identity.
const DEFAULT_SOURCE = "synmetrix";

// Canonical DNS namespace (== Python `uuid.NAMESPACE_DNS`) so message_id /
// event_gid are byte-identical to the other producers' deterministic ids.
const DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// Issuing system for every involve id_type (required field, always "FraiOS").
const ID_TYPE = "FraiOS";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ *
 * entity_gid derivation — ported verbatim from the normative shared
 * implementation (fraios `apps/rule-engine/src/events/entity-gid.js`,
 * pinned by `shared/schemas/events/entity-gid-vectors.json`). A well-formed
 * RFC-4122 UUID passes through UNCHANGED (original case preserved); any other
 * stable id — including "" — maps via four parallel 32-bit FNV-1a lanes over
 * UTF-16 code units, forced to a v4-shaped UUID. This is NOT uuid5 and must not
 * be replaced with uuid5 (that would silently split the identity space).
 * ------------------------------------------------------------------ */

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Loose UUID shape — matches Python `_is_uuid` (used only to decide whether to
 * also keep the raw `id` on an involve entry). */
const UUID_LOOSE_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Four parallel 32-bit FNV-1a lanes over the input's UTF-16 code units.
 * `Math.imul(...) >>> 0` is load-bearing at EVERY step — it is what keeps each
 * lane a wrapping 32-bit multiply.
 */
function hashToBytes(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0xdeadbeef;
  let h3 = 0x811c9dc5 ^ 0x41c6ce57;
  let h4 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
    h3 = Math.imul(h3 ^ c, 0x01000193) >>> 0;
    h4 = Math.imul(h4 ^ c, 0x01000193) >>> 0;
  }
  const bytes = new Uint8Array(16);
  const write = (h, offset) => {
    bytes[offset] = (h >>> 24) & 0xff;
    bytes[offset + 1] = (h >>> 16) & 0xff;
    bytes[offset + 2] = (h >>> 8) & 0xff;
    bytes[offset + 3] = h & 0xff;
  };
  write(h1, 0);
  write(h2, 4);
  write(h3, 8);
  write(h4, 12);
  return bytes;
}

function hashToUuid(input) {
  const bytes = hashToBytes(input);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const toHex = (b) => b.toString(16).padStart(2, "0");
  const hex = Array.from(bytes, toHex).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Canonical graph UUID for an entity, placed in `involves[].entity_gid` and the
 * envelope `entity_gid`. RFC-4122 passthrough (original case), else hashToUuid.
 *
 * Callers must reject an EMPTY *account* identifier before emitting: "" derives
 * to a well-formed UUID, which would file every credential-less event under one
 * shared synthetic tenant.
 *
 * @param {string} raw the identifier as minted
 * @returns {string} a canonical UUID
 */
export function normalizeEntityGid(raw) {
  const s = String(raw ?? "");
  return UUID_REGEX.test(s) ? s : hashToUuid(s);
}

/* ------------------------------------------------------------------ *
 * Envelope helpers — snake_case SemanticEvent conventions, ported from the
 * canonical shared builder (fraios `libs/python/fraios-core/.../envelope.py`).
 * ------------------------------------------------------------------ */

/** Deterministic uuid5 message_id from stable parts joined by ":". */
export function messageIdFor(...parts) {
  const name = parts.map((p) => String(p ?? "")).join(":");
  return uuidv5(name, DNS_NAMESPACE);
}

/** Deterministic, replay-stable event_gid derived from the message_id. */
function eventGidFor(messageId) {
  return uuidv5(String(messageId).toLowerCase(), DNS_NAMESPACE);
}

/** (source, environment, host) for origin tagging on every event. */
function sourceInfo() {
  const source = (CXS_EVENT_SOURCE || "").trim() || DEFAULT_SOURCE;
  let env = (CXS_ENVIRONMENT || "").trim();
  if (!env) env = process.env.KUBERNETES_SERVICE_HOST ? "cluster" : "local";
  const host = (process.env.HOSTNAME || "").trim() || hostname();
  return { source, environment: env, host };
}

/**
 * One involve entry (fraios id model): graph UUID in `entity_gid`; a non-UUID
 * source id also kept in `id`; `id_type` always "FraiOS".
 *
 * @param {string} role
 * @param {string} entity_type
 * @param {string} value the entity's stable id as minted
 * @param {string} [label]
 */
export function involve(role, entity_type, value, label) {
  const entry = {
    role,
    entity_type,
    entity_gid: normalizeEntityGid(value),
    id_type: ID_TYPE,
  };
  const s = String(value ?? "");
  if (s && !UUID_LOOSE_REGEX.test(s)) entry.id = s;
  if (label) entry.label = label;
  return entry;
}

/**
 * Canonical snake_case SemanticEvent skeleton. Origin info on every event
 * (`source`; `environment` in dimensions; `producer_host`/`producer_env` in
 * properties); deterministic `event_gid`.
 */
export function buildEnvelope({
  event,
  abstract_event,
  message_id,
  timestamp,
  partition,
  entity_gid,
  involves,
  type = "log",
  customer_facing = 0,
  dimensions = null,
  metrics = null,
  analysis = null,
  properties = null,
}) {
  const { source, environment, host } = sourceInfo();
  const dims = { ...(dimensions || {}), environment };
  const props = {
    ...(properties || {}),
    producer_host: host,
    producer_env: environment,
  };
  const envelope = {
    type,
    event,
    abstract_event,
    message_id,
    event_gid: eventGidFor(message_id),
    timestamp,
    partition,
    entity_gid: normalizeEntityGid(entity_gid),
    customer_facing,
    source,
    dimensions: dims,
    involves,
    properties: props,
  };
  if (metrics) envelope.metrics = metrics;
  if (analysis) envelope.analysis = analysis;
  return envelope;
}

/* ------------------------------------------------------------------ *
 * Connection Called — the billable record (contract:
 * specs/099-semantic-events/contracts/billable-record.md). Exactly one per
 * provider/vendor call; ungated; `amount` + `currency` ALWAYS present.
 * ------------------------------------------------------------------ */

/**
 * Build the compliant `Connection Called` envelope for a single provider call.
 *
 * `amount` + `currency` are ALWAYS present (contract: absence is a violation).
 * A free/priced call ships `amount, pricing: "known"`; an unpriced model ships
 * `amount: 0.0, pricing: "unknown"`.
 *
 * @param {object}  args
 * @param {string}  args.partition     tenant partition (required)
 * @param {string}  args.accountId     OWNED_BY account id as minted (required)
 * @param {string}  [args.userId]      REQUESTED_BY person id, when a human is attributable
 * @param {string}  args.provider      vendor (e.g. "openai")
 * @param {string}  [args.model]       model / variant id
 * @param {string}  args.item          `feature:operation` slug (never a vendor name)
 * @param {number}  [args.durationMs]  wall-clock call duration
 * @param {number}  [args.cost]        USD cost; null/undefined ⇒ unpriced ⇒ amount 0.0 + pricing "unknown"
 * @param {string}  [args.connectionId] USES_CONNECTION connection id, when known
 * @param {"ok"|"error"} [args.status] call outcome (default "ok")
 * @param {string}  [args.timestamp]   ISO timestamp (default now)
 * @returns {object} canonical Connection Called envelope
 */
export function buildConnectionCalled({
  partition,
  accountId,
  userId = null,
  provider,
  model = null,
  item,
  durationMs = null,
  cost = null,
  connectionId = null,
  status = "ok",
  timestamp = null,
} = {}) {
  const ts = timestamp || new Date().toISOString();
  const priced = cost != null && Number.isFinite(Number(cost));
  const amount = priced ? Number(cost) : 0.0; // ALWAYS present
  const currency = "USD"; // ALWAYS present
  const pricing = priced ? "known" : "unknown";

  // Owner id for the envelope entity_gid / OWNED_BY — fall back to partition so
  // a record is never filed under the derived-empty synthetic tenant.
  const ownerId = String(accountId ?? "") || String(partition ?? "");

  // Deterministic-ish id: tenant + event + provider/model/item + status + ts.
  // (Handlers T087–T090 should prefer the provider call id when available.)
  const message_id = messageIdFor(
    partition,
    "Connection Called",
    provider,
    model,
    item,
    status,
    ts
  );

  const involves = [involve("OWNED_BY", "Account", ownerId)];
  if (userId) involves.push(involve("REQUESTED_BY", "Person", String(userId)));
  if (connectionId)
    involves.push(involve("USES_CONNECTION", "Connection", String(connectionId)));

  const dimensions = { provider, status, item };
  if (model) dimensions.model = model;

  const metrics = {};
  if (durationMs != null && Number.isFinite(Number(durationMs))) {
    metrics.duration_ms = Number(durationMs);
  }

  const analysisEntry = {
    item,
    provider,
    variant: model,
    amount,
    currency,
  };
  if (durationMs != null && Number.isFinite(Number(durationMs))) {
    analysisEntry.processing_time = Number(durationMs) / 1000;
  }

  return buildEnvelope({
    event: "Connection Called",
    abstract_event: "Connection Called",
    message_id,
    timestamp: ts,
    partition: String(partition ?? ""),
    entity_gid: ownerId,
    involves,
    type: "log",
    customer_facing: 0,
    dimensions,
    metrics: Object.keys(metrics).length ? metrics : null,
    analysis: [analysisEntry],
    // FR-043 "unknown pricing" marker rides the top-level `properties` JSON
    // column — the analysis[] Nested has fixed subcolumns and the persister
    // drops unknown keys like `extras` (review P1-4).
    properties: { pricing },
  });
}

/**
 * Build + fire-and-forget a billable `Connection Called` record for a single
 * provider call.
 *
 * Fully guarded like {@link emitModelEvent}: NEVER throws (FR-007) and NEVER
 * blocks the caller — the ingression POST is detached, so a slow inbox can
 * never delay the provider call's own path. Skips silently when there is no
 * tenant to attribute (neither accountId nor partition): a credential-less
 * record would file under the derived-empty synthetic tenant, and a credential
 * is never invented to fill the gap (A4).
 *
 * `properties` (optional) is merged onto the envelope's free-form properties
 * slot — the smart-generation callers (099 T088) use it to carry `attempts` /
 * `pass` context so a silent LLM degradation stays auditable. The billing
 * contract itself lives in dimensions/analysis (amount+currency always) and is
 * untouched by this merge.
 *
 * @param {object} args same shape as {@link buildConnectionCalled}, plus:
 * @param {object} [args.properties] free-form context merged onto the envelope
 */
export function emitConnectionCalled(args = {}) {
  try {
    const {
      accountId = null,
      partition = null,
      userId = null,
      properties = null,
    } = args;
    if (!accountId && !partition) return; // no tenant → skip, never invent one
    const envelope = buildConnectionCalled(args);
    if (properties && typeof properties === "object") {
      // Producer proof is IMMUTABLE: re-stamp it AFTER merging caller-supplied
      // properties so a caller can never override it (review P1-6).
      const builtProducer = envelope.properties?.producer;
      envelope.properties = { ...(envelope.properties || {}), ...properties };
      if (builtProducer != null) envelope.properties.producer = builtProducer;
    }
    // emitSemanticEvent is itself never-throw; the detached .catch is belt-and-
    // braces so an unexpected rejection can never surface as unhandled.
    emitSemanticEvent(envelope, { accountId, partition, userId }).catch(
      () => {}
    );
  } catch {
    // absolute never-throw guard (FR-007)
  }
}

/* ------------------------------------------------------------------ *
 * Model-management lifecycle events (099 T087, FR-091). Business-class,
 * category `lifecycle`, `type: "track"`. Every model event carries the
 * canonical involves grammar:
 *   OWNED_BY / Account   — the owning tenant (from tokenPayload.accountId,
 *                          falling back to the partition so a record is never
 *                          filed under the derived-empty synthetic tenant),
 *   ACTED_BY / Person    — the human who performed the action, when known,
 *   ABOUT   / Data Model — the dataschema / version / branch the event concerns.
 * Dimensions stay inside the declared key dictionary (`status` + the
 * auto-added `environment`); ids NEVER appear in dimensions (FR-031) — counts,
 * modes and other free-form context ride the un-keyed `properties` slot.
 * ------------------------------------------------------------------ */

/**
 * Build a canonical model-management lifecycle envelope.
 *
 * @param {object}  args
 * @param {string}  args.event       past-tense event name (e.g. "Model Saved")
 * @param {string}  args.partition   tenant partition (required for attribution)
 * @param {string}  [args.accountId] OWNED_BY account id as minted (id_type FraiOS)
 * @param {string}  [args.userId]    ACTED_BY person id, when a human is attributable
 * @param {string}  args.modelId     ABOUT Data Model id (dataschema/version/branch)
 * @param {string}  [args.modelLabel] optional human label for the model
 * @param {"ok"|"error"} [args.status] outcome (default "ok")
 * @param {object}  [args.dimensions] extra LowCardinality dimensions (declared keys only)
 * @param {object}  [args.metrics]    declared metric keys (e.g. record_count)
 * @param {object}  [args.properties] free-form context (counts, modes, ids-of-record)
 * @param {string}  [args.timestamp]  ISO timestamp (default now)
 * @returns {object} canonical SemanticEvent envelope
 */
export function buildModelEvent({
  event,
  partition,
  accountId = null,
  userId = null,
  modelId,
  modelLabel = null,
  status = "ok",
  dimensions = null,
  metrics = null,
  properties = null,
  timestamp = null,
} = {}) {
  const ts = timestamp || new Date().toISOString();
  // Owner id for OWNED_BY / entity_gid — fall back to partition so the record
  // is never filed under the derived-empty synthetic tenant (normalizeEntityGid).
  const ownerId = String(accountId ?? "") || String(partition ?? "");
  const aboutId = String(modelId ?? "") || ownerId;

  const message_id = messageIdFor(partition, event, aboutId, status, ts);

  const involves = [involve("OWNED_BY", "Account", ownerId)];
  if (userId) involves.push(involve("ACTED_BY", "Person", String(userId)));
  involves.push(involve("ABOUT", "Data Model", aboutId, modelLabel));

  return buildEnvelope({
    event,
    abstract_event: event,
    message_id,
    timestamp: ts,
    partition: String(partition ?? ""),
    entity_gid: aboutId,
    involves,
    type: "track",
    customer_facing: 0,
    dimensions: { status, ...(dimensions || {}) },
    metrics,
    properties,
  });
}

/**
 * Build + fire-and-forget a model-management lifecycle event.
 *
 * Fully guarded: NEVER throws (FR-007) and NEVER blocks the caller — the
 * ingression POST is detached, so a slow inbox can never delay the model
 * operation's response. Skips silently when there is no tenant to attribute
 * (neither accountId nor partition): a credential-less event would otherwise
 * file under the derived-empty synthetic tenant, and a credential is never
 * invented to fill the gap (A4).
 *
 * @param {object} args same shape as {@link buildModelEvent}
 */
export function emitModelEvent(args = {}) {
  try {
    const { accountId = null, partition = null, userId = null } = args;
    if (!accountId && !partition) return; // no tenant → skip, never invent one
    const envelope = buildModelEvent(args);
    // emitSemanticEvent is itself never-throw; the detached .catch is belt-and-
    // braces so an unexpected rejection can never surface as unhandled.
    emitSemanticEvent(envelope, { accountId, partition, userId }).catch(
      () => {}
    );
  } catch {
    // absolute never-throw guard (FR-007)
  }
}

/* ------------------------------------------------------------------ *
 * Query-shoulder + connection-test events (099 T089, US7 / FR-091).
 * `type: "track"`. These close the query/execution/session/export/profiling/
 * connection-test coverage gaps. Same canonical grammar as the model events:
 *   OWNED_BY / Account — the owning tenant (tokenPayload.accountId, id_type
 *                        FraiOS; falls back to the partition so a record is
 *                        never filed under the derived-empty synthetic tenant),
 *   ACTED_BY / Person  — the human who performed the action, when known,
 *   ABOUT   / <kind>   — OPTIONAL subject, using ONLY a vocab entity_type
 *                        (e.g. "Connection" for a datasource). Omitted where no
 *                        first-class subject id exists — the house involves
 *                        (OWNED_BY + ACTED_BY) still anchor the event.
 * Dimensions stay inside the declared key dictionary (`status` + the auto-added
 * `environment`, plus any caller-declared keys); ids NEVER appear in dimensions
 * (FR-031) — they ride ABOUT / the free-form `properties` slot.
 * ------------------------------------------------------------------ */

/**
 * Build a canonical query-shoulder / connection-test envelope.
 *
 * @param {object}  args
 * @param {string}  args.event       past-tense event name (e.g. "SQL Executed")
 * @param {string}  args.partition   tenant partition (required for attribution)
 * @param {string}  [args.accountId] OWNED_BY account id as minted (id_type FraiOS)
 * @param {string}  [args.userId]    ACTED_BY person id, when a human is attributable
 * @param {object}  [args.about]     OPTIONAL subject: { entity_type, id, label } — entity_type
 *                                   must be a vocab kind; omitted when id is null/absent
 * @param {"ok"|"error"} [args.status] outcome (default "ok")
 * @param {string}  [args.type]      envelope type (default "track")
 * @param {object}  [args.dimensions] extra LowCardinality dimensions (declared keys only)
 * @param {object}  [args.metrics]    declared metric keys (e.g. duration_ms, record_count)
 * @param {object}  [args.properties] free-form context (schema/table/format/ids-of-record)
 * @param {string}  [args.timestamp]  ISO timestamp (default now)
 * @returns {object} canonical SemanticEvent envelope
 */
export function buildQueryEvent({
  event,
  partition,
  accountId = null,
  userId = null,
  about = null,
  status = "ok",
  type = "track",
  customer_facing = 0,
  dimensions = null,
  metrics = null,
  properties = null,
  timestamp = null,
} = {}) {
  const ts = timestamp || new Date().toISOString();
  // Owner id for OWNED_BY / entity_gid — fall back to partition so the record
  // is never filed under the derived-empty synthetic tenant (normalizeEntityGid).
  const ownerId = String(accountId ?? "") || String(partition ?? "");

  const aboutId =
    about && about.id != null && String(about.id) !== ""
      ? String(about.id)
      : null;
  const aboutType = aboutId ? String(about.entity_type ?? "") : null;
  // entity_gid anchors on the subject when there is one, else on the tenant.
  const entityGid = aboutId || ownerId;

  const message_id = messageIdFor(
    partition,
    event,
    aboutId ?? "",
    status,
    ts
  );

  const involves = [involve("OWNED_BY", "Account", ownerId)];
  if (userId) involves.push(involve("ACTED_BY", "Person", String(userId)));
  if (aboutId && aboutType) {
    involves.push(involve("ABOUT", aboutType, aboutId, about.label));
  }

  return buildEnvelope({
    event,
    abstract_event: event,
    message_id,
    timestamp: ts,
    partition: String(partition ?? ""),
    entity_gid: entityGid,
    involves,
    type,
    customer_facing,
    dimensions: { status, ...(dimensions || {}) },
    metrics,
    properties,
  });
}

/**
 * Build + fire-and-forget a query-shoulder / connection-test event.
 *
 * Fully guarded like {@link emitModelEvent}: NEVER throws (FR-007) and NEVER
 * blocks the caller — the ingression POST is detached. Skips silently when there
 * is no tenant to attribute (neither accountId nor partition): a credential-less
 * event would file under the derived-empty synthetic tenant, and a credential is
 * never invented to fill the gap (A4). Credential is service-minted (the
 * registry declares `credential: service-minted`); the caller token is NOT
 * forwarded, mirroring the model-event emitter.
 *
 * @param {object} args same shape as {@link buildQueryEvent}
 */
export function emitQueryEvent(args = {}) {
  try {
    const { accountId = null, partition = null, userId = null } = args;
    if (!accountId && !partition) return; // no tenant → skip, never invent one
    const envelope = buildQueryEvent(args);
    // emitSemanticEvent is itself never-throw; the detached .catch is belt-and-
    // braces so an unexpected rejection can never surface as unhandled.
    emitSemanticEvent(envelope, { accountId, partition, userId }).catch(
      () => {}
    );
  } catch {
    // absolute never-throw guard (FR-007)
  }
}

/* ------------------------------------------------------------------ *
 * Buffered query-log emission (type='log'). The query path only ENQUEUES
 * (O(1), no network, never throws); a detached background flusher batches the
 * ingression POSTs OFF the query path, so semantic-event creation/emission can
 * NEVER affect query performance. The buffer is bounded (drops the oldest under
 * backpressure) and the flush timer is unref'd (never keeps the process alive).
 * ------------------------------------------------------------------ */

const LOG_BUFFER_MAX = Number(process.env.LOG_EVENT_BUFFER_MAX || 2000);
const LOG_FLUSH_MS = Number(process.env.LOG_EVENT_FLUSH_MS || 2000);
const LOG_FLUSH_BATCH = Number(process.env.LOG_EVENT_FLUSH_BATCH || 200);
const _logBuffer = [];
let _logFlusher = null;

function _drainLogBuffer() {
  const batch = _logBuffer.splice(0, LOG_FLUSH_BATCH);
  for (const item of batch) {
    // detached — a slow inbox can never delay the query path
    emitSemanticEvent(item.envelope, item.ctx).catch(() => {});
  }
}

function _startLogFlusher() {
  if (_logFlusher) return;
  _logFlusher = setInterval(_drainLogBuffer, LOG_FLUSH_MS);
  if (_logFlusher && _logFlusher.unref) _logFlusher.unref();
}

/**
 * Enqueue a pre-built log envelope for buffered, off-path delivery. Synchronous,
 * O(1), never throws. Drops the oldest buffered event once the bound is hit so a
 * slow/unreachable inbox can never grow memory without limit.
 */
export function enqueueLogEvent(envelope, ctx = {}) {
  try {
    if (_logBuffer.length >= LOG_BUFFER_MAX) _logBuffer.shift();
    _logBuffer.push({ envelope, ctx });
    _startLogFlusher();
  } catch {
    // never throw into the caller (the cube query logger)
  }
}

/**
 * Build + BUFFER-emit a `Query Executed` log event (type='log') for one completed
 * cube analytical query. Called from the cube `logger` hook (src/utils/logging.js);
 * it ENQUEUES only, so query performance is never affected. Skips silently when
 * there is no tenant to attribute (A4 — a credential is never invented).
 *
 * @param {object} args same shape as {@link buildQueryEvent} (minus event/type)
 */
export function emitQueryLog(args = {}) {
  try {
    const { accountId = null, partition = null, userId = null } = args;
    if (!accountId && !partition) return; // no tenant → skip, never invent one
    const envelope = buildQueryEvent({
      ...args,
      event: "Query Executed",
      type: "log",
    });
    enqueueLogEvent(envelope, { accountId, partition, userId });
  } catch {
    // absolute never-throw guard (FR-007)
  }
}

/* ------------------------------------------------------------------ *
 * Credential + transport.
 * ------------------------------------------------------------------ */

/**
 * Mint a short-lived FraiOS-shaped service token (HS256 over `TOKEN_SECRET`),
 * mirroring `mintHasuraToken.js`. Carries `accountId`/`partition`/`userId` so
 * the ingression side attributes the write to the operating tenant.
 *
 * Never throws. Returns the signed JWT, or `null` when no `TOKEN_SECRET` is
 * configured (the caller then skips + counts — a credential is never invented).
 *
 * @returns {Promise<string|null>}
 */
export async function mintServiceToken({
  accountId = null,
  partition = null,
  userId = null,
} = {}) {
  try {
    if (!TOKEN_SECRET) return null;
    const secret = new TextEncoder().encode(TOKEN_SECRET);
    const claims = { provider: SERVICE_PROVIDER };
    if (accountId != null) claims.accountId = String(accountId);
    if (partition != null) claims.partition = String(partition);
    if (userId != null) claims.userId = String(userId);
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setIssuer("services:cubejs")
      .setAudience("fraios:ingression")
      .setExpirationTime(`${SERVICE_TOKEN_TTL_MIN}m`)
      .sign(secret);
  } catch {
    return null;
  }
}

function logSkip(reason, envelope, extra = {}) {
  try {
    console.error(
      JSON.stringify({
        level: "error",
        event: "semantic_event_emit_failed",
        reason,
        event_name: envelope?.event ?? null,
        partition: envelope?.partition ?? null,
        message_id: envelope?.message_id ?? null,
        ...extra,
        ts: new Date().toISOString(),
      })
    );
  } catch {
    // stderr must never itself throw — swallow.
  }
}

/**
 * emitSemanticEvent — best-effort, fire-and-forget POST of a canonical envelope
 * to the ingression endpoint. NEVER throws (FR-007); the caller is never
 * informed of a transport failure — observability bookkeeping must not block a
 * user response.
 *
 * `POST {INGRESSION_HOST}/api/s/{envelope.type||'log'}` with header
 * `writekey: <token>`. Best-effort with 3 attempts + exponential backoff
 * (mirrors auditWriter.js). On exhausted attempts a structured stderr line is
 * emitted and `{ ok: false }` returned.
 *
 * Credential: `opts.token` (forwarded caller token) is used verbatim; otherwise
 * a short-lived service token is minted from `TOKEN_SECRET` using the envelope's
 * tenant (or `opts.accountId`/`opts.partition`/`opts.userId`).
 *
 * @param {object} envelope canonical SemanticEvent (e.g. from buildConnectionCalled)
 * @param {object} [opts]
 * @param {string} [opts.token]     forwarded caller token → used as writekey
 * @param {string} [opts.accountId] tenant account id for the minted token
 * @param {string} [opts.partition] tenant partition for the minted token
 * @param {string} [opts.userId]    person id for the minted token
 * @returns {Promise<{ok: true, status: number} | {ok: false}>}
 */
export async function emitSemanticEvent(
  envelope,
  { token = null, accountId = null, partition = null, userId = null } = {}
) {
  try {
    if (!envelope || typeof envelope !== "object") {
      logSkip("missing_envelope", envelope);
      return { ok: false };
    }

    const ownerInvolve = Array.isArray(envelope.involves)
      ? envelope.involves.find((i) => i?.role === "OWNED_BY")
      : null;

    let writekey = token;
    if (!writekey) {
      writekey = await mintServiceToken({
        accountId: accountId ?? ownerInvolve?.id ?? null,
        partition: partition ?? envelope.partition ?? null,
        userId,
      });
    }
    if (!writekey) {
      // A4: no forwarded credential and none can be minted — skip + count,
      // never invent one.
      logSkip("no_writekey", envelope);
      return { ok: false };
    }

    const host = (INGRESSION_HOST || DEFAULT_INGRESSION_HOST).replace(
      /\/+$/,
      ""
    );
    const type = envelope.type || "log";
    const url = `${host}/api/s/${encodeURIComponent(type)}`;
    const body = JSON.stringify(envelope);

    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            writekey,
          },
          body,
        });
        if (res.ok) return { ok: true, status: res.status };
        lastErr = new Error(`ingression responded ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
      if (attempt < MAX_ATTEMPTS) {
        await sleep(INITIAL_BACKOFF_MS * 2 ** (attempt - 1));
      }
    }

    logSkip("transport_failed", envelope, {
      detail: lastErr?.message || "unknown",
    });
    return { ok: false };
  } catch (err) {
    // Absolute never-throw guard — even an unexpected failure (bad env, JSON
    // serialisation, etc.) must not propagate to the caller.
    logSkip("unexpected", envelope, { detail: err?.message || "unknown" });
    return { ok: false };
  }
}
