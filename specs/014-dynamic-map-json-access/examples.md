# Examples: Dynamic Map/JSON Field Access

How templates declare slots and registries, how clients discover dynamic properties, and how the query composer builds queries from them. All key names below are real (elko.is / somi.is dev data).

## 1. Template authoring

### 1a. Parameter slots on the base default model (dynamic access for ANY key)

```yaml
cubes:
  - name: SemanticEvents
    sql_table: cst.semantic_events
    meta: { default_model: true, template: semantic_events }
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta: { from_template: true }

      # --- dimensions map: 2 slots -------------------------------------
      - name: dim_key_a          # key selector: echoes its own FILTER_PARAMS value
        sql: "{FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}"  # bound-param tautology when filtered
        type: string
        public: false
        meta: { from_template: true, param_slot: { map: dimensions, role: key, slot: a } }
      - name: dim_value_a        # value fetcher
        sql: "{CUBE}.dimensions[{FILTER_PARAMS.SemanticEvents.dim_key_a.filter((v) => v)}]"  # YAML output renders `lambda v: v`
        type: string
        meta: { from_template: true, param_slot: { map: dimensions, role: value, slot: a } }
      # (dim_key_b / dim_value_b identical with slot: b)

      # --- flags map: 1 boolean slot -----------------------------------
      - name: flag_key_a
        sql: "{FILTER_PARAMS.SemanticEvents.flag_key_a.filter((v) => v)}"
        type: string
        public: false
        meta: { from_template: true, param_slot: { map: flags, role: key, slot: a } }
      - name: flag_value_a
        sql: "{CUBE}.flags[{FILTER_PARAMS.SemanticEvents.flag_key_a.filter((v) => v)}]"
        type: boolean
        meta: { from_template: true, param_slot: { map: flags, role: value, slot: a } }

    measures:
      - name: count
        type: count
        meta: { from_template: true }
      # --- metrics map: sum slots --------------------------------------
      - name: metric_sum_a
        sql: "CAST({CUBE}.metrics[{FILTER_PARAMS.SemanticEvents.metric_key_a.filter((v) => v)}] AS Float64)"
        type: sum
        meta: { from_template: true, param_slot: { map: metrics, role: value, slot: a, agg: sum } }
```

Slots are ordinary declared, template-owned members: they roll out through 013 (canary, validation, template-wins), are governed by access lists, and are the ONLY bridge to dynamic keys. The model never grows from usage.

### 1b. Event-scoped explicit template (editorial registry)

```yaml
cubes:
  - name: SupportConversations
    sql: SELECT * FROM cst.semantic_events WHERE event = 'Support Conversation Ended'
    meta:
      default_model: true
      template: support_conversations
      field_policy: explicit          # probe PRUNES this registry; adds NOTHING
    dimensions:
      - name: outcome
        sql: "{CUBE}.dimensions['outcome']"
        type: string
        meta: { from_template: true, registry_key: dimensions.outcome }
      - name: language_of_chat
        sql: "{CUBE}.dimensions['language_of_chat']"
        type: string
        meta: { from_template: true, registry_key: dimensions.language_of_chat }
      - name: urgency
        sql: "{CUBE}.dimensions['urgency']"
        type: string
        meta: { from_template: true, registry_key: dimensions.urgency }
      - name: user_needed_help_with           # registered JSON path, typed
        sql: "toString({CUBE}.properties.user_needed_help_with)"
        type: string
        meta: { from_template: true, registry_path: "properties.user_needed_help_with (string)" }
    measures:
      - name: conversations
        type: count
        meta: { from_template: true }
```

Per team, reconciliation keeps only registry members whose key/path occurs in that team's data for that event — a small, meaningful cube (elko.is: 6 keys max per event). Exposing a new key = a template edit = a reviewed, versioned, canary-rolled change.

## 2. Discovery: `POST /api/v1/meta/dynamic`

Request (standard CubeJS auth: `Authorization` + `x-hasura-datasource-id`):

```json
{
  "cube": "SemanticEvents",
  "filters": [{ "member": "SemanticEvents.event", "operator": "equals",
                "values": ["Support Conversation Ended"] }],
  "targets": ["dimensions", "metrics", "flags", "properties"]
}
```

Response (cube-meta-shaped; cached — see `freshness`):

```json
{
  "cube": "SemanticEvents",
  "scope": { "filters": [{ "member": "SemanticEvents.event", "operator": "equals",
                            "values": ["Support Conversation Ended"] }] },
  "freshness": { "generatedAt": "2026-07-07T02:41:00Z", "ttlMs": 120000, "cached": false },
  "dynamicMembers": {
    "dimensions": [
      {
        "name": "SemanticEvents.dimensions.outcome",
        "shortTitle": "Outcome", "title": "Dimensions › Outcome",
        "type": "string", "memberKind": "dimension",
        "source": { "column": "dimensions", "kind": "map", "key": "outcome",
                     "valueType": "LowCardinality(String)" },
        "stats": { "occurrences": 172345, "coverage": 0.99, "cardinality": 4,
                    "sampleValues": ["resolved", "unresolved", "escalated"] },
        "query": {
          "rest": { "dimension": "SemanticEvents.dimensions.outcome" },
          "sql": "dimensions['outcome']"
        }
      }
    ],
    "measures": [
      {
        "name": "SemanticEvents.metrics.duration",
        "type": "number", "memberKind": "measure", "aggregations": ["sum", "avg"],
        "source": { "column": "metrics", "kind": "map", "key": "duration",
                     "valueType": "Float32" },
        "stats": { "occurrences": 141202, "coverage": 0.81 },
        "query": { "rest": { "measure": "SemanticEvents.metrics.duration" },
                    "sql": "metrics['duration']" }
      }
    ],
    "segments": [
      { "name": "SemanticEvents.flags.escalated", "memberKind": "segment",
        "source": { "column": "flags", "kind": "map", "key": "escalated", "valueType": "Bool" },
        "query": { "rest": { "dimension": "SemanticEvents.flags.escalated" },
                    "sql": "flags['escalated']" } }
    ],
    "properties": [
      {
        "name": "SemanticEvents.properties.user_needed_help_with",
        "memberKind": "dimension",
        "source": { "column": "properties", "kind": "json",
                     "path": "user_needed_help_with",
                     "dominantType": "String", "typeShare": 0.97 },
        "stats": { "occurrences": 10223 },
        "query": { "rest": { "dimension": "SemanticEvents.properties.user_needed_help_with" },
                    "sql": "toString(properties.user_needed_help_with)" }
      }
    ]
  }
}
```

The `query` block is the contract for programmatic composition: dashboards and the query composer copy `query.rest` members into REST queries verbatim, or `query.sql` into SQL-API statements.

## 3. Querying with the canonical syntax (REST)

The composer picks entries from discovery and issues an ordinary `/api/v1/load`:

```json
{ "query": {
    "measures":   ["SemanticEvents.count", "SemanticEvents.metrics.duration"],
    "dimensions": ["SemanticEvents.dimensions.outcome"],
    "filters":    [{ "member": "SemanticEvents.event", "operator": "equals",
                     "values": ["Support Conversation Ended"] }]
} }
```

The 013 pre-processor (rule R3) rewrites this before validation into slot form — no model change ever happens:

```json
{ "query": {
    "measures":   ["SemanticEvents.count", "SemanticEvents.metric_sum_a"],
    "dimensions": ["SemanticEvents.dim_value_a"],
    "filters": [
      { "member": "SemanticEvents.event",        "operator": "equals", "values": ["Support Conversation Ended"] },
      { "member": "SemanticEvents.dim_key_a",    "operator": "equals", "values": ["outcome"] },
      { "member": "SemanticEvents.metric_key_a", "operator": "equals", "values": ["duration"] },
      { "member": "SemanticEvents.partition",    "operator": "equals", "values": ["elko.is"] }
    ]
} }
```

**Result-column naming (important for composers):** REST responses name columns after the *slot members* (`SemanticEvents.dim_value_a`, `SemanticEvents.metric_sum_a`). The composer maps them back to the requested keys from its own request context (it knows it asked for `dimensions.outcome` → slot a). Two distinct keys of one map occupy slots a and b independently (verified: FILTER_PARAMS resolves per member).

**Slot exhaustion** — three distinct `dimensions.*` keys in one query with two slots:

```json
{ "error": "Dynamic key slots exhausted",
  "code": "DYNAMIC_KEY_SLOTS_EXHAUSTED",
  "map": "dimensions", "slots": 2,
  "requested": ["outcome", "language_of_chat", "urgency"] }
```

Fix: query the event-scoped cube where those keys are real members (§1b), raise the slot count in the template (explicit decision), or use the SQL API.

**Unknown key** (present in syntax, absent in data): returns empty groups — SQL-natural and intentional. Discovery exists so composers never build such queries blind.

## 4. SQL API — the fully dynamic surface

Arbitrary keys and JSON paths work today over the SQL API (pushdown), with tenant scoping enforced by the platform's rewrite rules:

```sql
-- any map key, no slots involved
SELECT dimensions['language_spoken'] AS lang, measure(count)
FROM semantic_events
WHERE event = 'Support Conversation Ended'
GROUP BY 1 ORDER BY 2 DESC;

-- JSON path with explicit cast
SELECT toString(properties.user_needed_help_with) AS topic, measure(count)
FROM semantic_events GROUP BY 1;
```

Use REST+slots for governed dashboards; SQL API for exploration and BI tools.

## 5. Composer recipe (end-to-end)

1. `POST /api/v1/meta/dynamic` with the user's current filter context (e.g. selected event) → render the property picker directly from `dynamicMembers` (it is already member-shaped; `stats` drive ordering/badges).
2. User picks properties → copy each entry's `query.rest` member into the query; keep a `slotContext` map of requested-key → member-name.
3. Execute `/api/v1/load`. On response, translate slot column names back through `slotContext` for display.
4. Re-call discovery when the filter context changes or `freshness` expires; identical calls within TTL are served from cache.

## Notes & guard rails

- Never select a whole map column (driver hydration corrupts complex values — platform research); every generated/rewritten access is element-level with scalar results.
- JSON dynamic access on REST is registry-first: register hot paths in templates (fast typed subcolumns); use SQL API for arbitrary paths. Slots target the uniformly-typed maps.
- Slot count and aggregations are template decisions — raising them is a reviewed change, not an automatic reaction.

## Measurement footnotes (T120/T121, recorded 2026-07-07, live dev stack + ClickHouse)

- **Composer loop (SC-001)**: cold discovery on the elko.is partition (28,807 rows under `event = 'Support Conversation Ended'`) = **1.77s** after parallelizing the per-column probes (2.86s serial before); warm (cache hit) = **4ms**. Full discovery→compose→execute well under the 3s target.
- **Discovery cache (SC-002)**: warm p50 4ms (≪ 50ms target); cold ≤ 1.8s p95 per cube. Cache key = md5(partition, cube, targets, filters, schemaVersion); TTL `DYNAMIC_META_TTL_MS` (120s default).
- **Dynamic key end-to-end (US1)**: `SemanticEvents.dimensions.outcome` rewritten to `dim_value_a` + injected `dim_key_a = 'outcome'` returned 12 real groups (Resolved 19237, Unresolved 3496, …) — value fetched by a query-supplied key with zero model members added.
- **Explicit registry pruning (US3/SC-003)**: an event-scoped `support_conversations` template with 5 declared registry members reconciled to exactly the 3 present in elko.is under that event (`outcome`, `urgency`, `help_topic`); `store_format` and `never_seen_path` pruned. Zero probe-derived additions.
- **Security — no regression to query rewriting (verified live)**: R3 runs BEFORE R1/R2, and R2 still injects the partition scope filter (`SemanticEvents.partition equals ['elko.is']`) onto the rewritten query alongside the R3 key filter — confirmed in `/dry-run` normalizedQueries. Slot value members carry the baked partition literal (FR-005) exactly as ordinary derived members. The pre-processor still fails open to gateway auth on any resolution error. All 6 StepCI suites (116 steps incl. preprocessor 21/21, tenant isolation, dynamic-access 29/29) pass; cubejs unit 624/626 (2 pre-existing `partition.test.js` failures unrelated to 013/014), actions 52/52, error-code lint green.
- **Tenancy hardening (from this pass)**: `resolveDefaultModelContext` is now datasource-first with a tenancy cross-check — the request's `x-hasura-datasource-id` must resolve to a datasource whose owning team's partition equals the caller's JWT partition AND whose name is the configured target. Strictly tighter than the prior partition→team chain: a caller can never receive another partition's member map even if teams share a partition value.
- **SC-007 (no churn)**: a healthy slot+registry team reconciled 3× → `updated` then `skipped_no_change`, `skipped_no_change` (deterministic; slot/registry/JSON-probe generation is checksum-stable). Sorted-file checksum guard (013) unaffected.
