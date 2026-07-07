# Dynamic Field Access — Query Guide

Reach any ClickHouse **map** or **JSON** key by name, without growing the model.

Behavioral events store open-ended attributes in ClickHouse maps (`dimensions`,
`metrics`, `flags`) and a native `JSON` column (`properties`). Keys vary row by row —
effectively per event type — so materializing every observed key would produce one
unusable mega-model. Instead the model stays deliberate and only the **key** is dynamic
at query time.

> **Every request and response in this guide was executed against the live dev stack
> (ClickHouse 26.6) on 2026-07-07 and copied in verbatim.** Counts are a snapshot of the
> `somi.is` partition (13.9 M rows) and will drift as data lands; the query shapes,
> rewrite behavior, and error codes are stable.

Related docs: [feature spec](../specs/014-dynamic-map-json-access/spec.md) ·
[template authoring & composer recipes](../specs/014-dynamic-map-json-access/examples.md) ·
[parent feature (default models)](../specs/013-mature-default-models/spec.md).

---

## The idea

A single event touches only a handful of keys; across every event the union is huge.
Two mechanisms cover everything, with **no member ever created implicitly**:

- **Parameter slots** — a fixed, declared pair of members per map (`dim_key_a` selects
  the key, `dim_value_a` fetches its value). You reference `Cube.dimensions.anything`;
  the query pre-processor maps it onto a free slot and injects the key filter **before
  validation**.
- **Discovery** — an endpoint that probes your team's data under a filter and returns
  the keys that actually exist right now, shaped like model metadata, so a dashboard or
  query composer can build queries programmatically.

**The rewrite, at a glance:**

```
You write:                              What runs (pre-validation):
SemanticEvents.dimensions.store_format   member  SemanticEvents.dim_value_a
                                         filter  dim_key_a = "store_format"
                                         scope   partition = "somi.is"
```

Everything below is scoped to your team's partition automatically — you never pass a
partition; the platform injects it (see [How scoping stays safe](#how-scoping-stays-safe)).

---

## 1. Discover properties

Call `POST /api/v1/meta/dynamic` with a cube and an optional filter (usually one event
type). You get a directory of available map keys and JSON paths — each with occurrence
stats, sample values, and a ready-to-paste query form. Results are cached for two minutes
(`DYNAMIC_META_TTL_MS`).

**Request** — `POST /api/v1/meta/dynamic`
*(headers: `Authorization: Bearer <jwt>`, `x-hasura-datasource-id: <id>`)*

```json
{
  "cube": "SemanticEvents",
  "targets": ["dimensions", "metrics"],
  "filters": [
    { "member": "SemanticEvents.event", "operator": "equals", "values": ["Sales Report Submitted"] }
  ]
}
```

**Response** `200` — *verified · somi.is · 158,604 rows under this event*

```json
{
  "cube": "SemanticEvents",
  "totalRows": 158604,
  "freshness": { "generatedAt": "2026-07-07T13:26:38Z", "ttlMs": 120000, "cached": false },
  "dynamicMembers": {
    "dimensions": [
      {
        "name": "SemanticEvents.dimensions.season",
        "type": "string", "memberKind": "dimension",
        "source": { "column": "dimensions", "kind": "map", "key": "season", "valueType": "String" },
        "stats": {
          "occurrences": 158604, "coverage": 1, "cardinality": 4,
          "sampleValues": ["winter", "spring", "fall", "summer"]
        },
        "query": {
          "rest": { "dimension": "SemanticEvents.dimensions.season" },
          "sql": "dimensions['season']"
        }
      }
    ],
    "measures": [
      {
        "name": "SemanticEvents.metrics.total_units_delivered",
        "type": "number", "memberKind": "measure", "aggregations": ["sum", "avg"],
        "source": { "column": "metrics", "kind": "map", "key": "total_units_delivered", "valueType": "Float32" },
        "stats": { "occurrences": 158604, "cardinality": 975 },
        "query": {
          "rest": { "measure": "SemanticEvents.metrics.total_units_delivered" },
          "sql": "metrics['total_units_delivered']"
        }
      }
    ]
  }
}
```

The full response for this event listed nine dimension keys — `season`, `chain`,
`day_name`, `density_tier`, `store_format`, `archetype_day`, `store_brand`, `weather`,
`holiday_name` — each with its own `query.rest` block. A composer renders that array
straight into a property picker.

---

## 2. Query a map key

Reference the key with dotted syntax in an ordinary `/api/v1/load` query. The response
column carries the slot name (`dim_value_a`); your composer maps it back to the requested
key.

**Request** — `POST /api/v1/load`

```json
{
  "query": {
    "measures": ["SemanticEvents.count"],
    "dimensions": ["SemanticEvents.dimensions.store_format"],
    "filters": [
      { "member": "SemanticEvents.event", "operator": "equals", "values": ["Sales Report Submitted"] }
    ],
    "order": { "SemanticEvents.count": "desc" }
  }
}
```

**Response** `200` — *verified*

```json
[
  { "SemanticEvents.dim_value_a": "Discount Supermarket", "SemanticEvents.count": "82180" },
  { "SemanticEvents.dim_value_a": "Fuel Station",         "SemanticEvents.count": "39202" },
  { "SemanticEvents.dim_value_a": "Local Grocery",        "SemanticEvents.count": "20471" },
  { "SemanticEvents.dim_value_a": "Hypermarket",          "SemanticEvents.count": "7567"  },
  { "SemanticEvents.dim_value_a": "Service Station",      "SemanticEvents.count": "4241"  }
]
```

> A key that isn't in your data returns zero groups — SQL-natural, not an error.
> Discovery (§1) is how you avoid composing a blind query.

---

## 3. Combine two keys

Ask for two keys of the same map and each claims its own slot (`dim_value_a`,
`dim_value_b`). Keys are assigned **alphabetically**, so the mapping is deterministic.

**Request** — `POST /api/v1/load`

```json
{
  "query": {
    "measures": ["SemanticEvents.count"],
    "dimensions": [
      "SemanticEvents.dimensions.store_format",
      "SemanticEvents.dimensions.season"
    ],
    "filters": [
      { "member": "SemanticEvents.event", "operator": "equals", "values": ["Sales Report Submitted"] }
    ],
    "order": { "SemanticEvents.count": "desc" }
  }
}
```

**Response** `200` — *verified*

```json
[
  { "SemanticEvents.dim_value_b": "Discount Supermarket", "SemanticEvents.dim_value_a": "summer", "SemanticEvents.count": "21341" },
  { "SemanticEvents.dim_value_b": "Discount Supermarket", "SemanticEvents.dim_value_a": "spring", "SemanticEvents.count": "20650" },
  { "SemanticEvents.dim_value_b": "Discount Supermarket", "SemanticEvents.dim_value_a": "fall",   "SemanticEvents.count": "20518" },
  { "SemanticEvents.dim_value_b": "Discount Supermarket", "SemanticEvents.dim_value_a": "winter", "SemanticEvents.count": "19671" }
]
```

`store_format` sorts after `season`, so it took slot `b` and `season` took slot `a` —
visible in the column names above.

---

## 4. Aggregate a metric

Metric maps become measures. Reference `SemanticEvents.metrics.<key>` for the sum, and
append `.avg` for the average — both share one slot's key filter.

**Request** — `POST /api/v1/load`

```json
{
  "query": {
    "measures": [
      "SemanticEvents.metrics.total_units_delivered",
      "SemanticEvents.metrics.total_units_delivered.avg"
    ],
    "dimensions": ["SemanticEvents.dimensions.season"],
    "filters": [
      { "member": "SemanticEvents.event", "operator": "equals", "values": ["Sales Report Submitted"] }
    ],
    "order": { "SemanticEvents.metrics.total_units_delivered": "desc" }
  }
}
```

**Response** `200` — *verified · sum matches ClickHouse exactly*

```json
[
  { "SemanticEvents.dim_value_a": "summer", "SemanticEvents.metric_sum_a": "5696790", "SemanticEvents.metric_avg_a": "137.89" },
  { "SemanticEvents.dim_value_a": "spring", "SemanticEvents.metric_sum_a": "4987138", "SemanticEvents.metric_avg_a": "125.04" },
  { "SemanticEvents.dim_value_a": "fall",   "SemanticEvents.metric_sum_a": "4815831", "SemanticEvents.metric_avg_a": "121.31" },
  { "SemanticEvents.dim_value_a": "winter", "SemanticEvents.metric_sum_a": "4011478", "SemanticEvents.metric_avg_a": "106.39" }
]
```

---

## 5. Curated event models

Slots are for open-ended exploration. For the fields that matter to a specific event, a
platform admin publishes an **event-scoped model** with an explicit registry — real named
members with descriptions and access control. Reconciliation keeps only the registry
members that occur in *your* data and prunes the rest. Nothing is ever added implicitly.

**Request** — `POST /api/v1/load`

```json
{
  "query": {
    "measures": ["SalesReports.reports", "SalesReports.units_delivered"],
    "dimensions": ["SalesReports.store_format"],
    "order": { "SalesReports.reports": "desc" }
  }
}
```

**Response** `200` — *verified · `SalesReports` scoped to "Sales Report Submitted"*

```json
[
  { "SalesReports.store_format": "Discount Supermarket", "SalesReports.reports": "82180", "SalesReports.units_delivered": "14762154" },
  { "SalesReports.store_format": "Fuel Station",         "SalesReports.reports": "39202", "SalesReports.units_delivered": "1737490"  },
  { "SalesReports.store_format": "Local Grocery",        "SalesReports.reports": "20471", "SalesReports.units_delivered": "635790"   },
  { "SalesReports.store_format": "Hypermarket",          "SalesReports.reports": "7567",  "SalesReports.units_delivered": "1389621"  }
]
```

This cube's template declared five members. The team's data lacked `does_not_exist_here`,
so that member was pruned during reconciliation — `store_format`, `season`, `weather` and
`units_delivered` remained. Clean, named, no clutter. (See
[examples.md](../specs/014-dynamic-map-json-access/examples.md) for the template YAML.)

---

## 6. Slot limits

Each map exposes a fixed number of slots (two by default for dimensions). Ask for more
distinct keys of one map in a single query and you get a specific, actionable error
**before** the query reaches validation — never a generic "unknown member".

**Request** — three dimension keys, two slots:

```json
{ "query": { "dimensions": [
  "SemanticEvents.dimensions.store_format",
  "SemanticEvents.dimensions.season",
  "SemanticEvents.dimensions.weather"
] } }
```

**Response** `400` — *verified*

```json
{
  "error": "Dynamic key slots exhausted",
  "code": "DYNAMIC_KEY_SLOTS_EXHAUSTED",
  "map": "dimensions",
  "slots": 2,
  "requested": ["season", "store_format", "weather"]
}
```

To go wider: split into multiple queries, use a curated model (§5) where those keys are
named members, raise the slot count in the template, or drop to the SQL API (§8).

---

## How scoping stays safe

The dynamic rewrite runs first, then the existing scoping rules run on the rewritten query
— unchanged. Inspect any dynamic query with `/api/v1/dry-run` and you see the partition
filter injected right alongside the key filter:

**Request** — `POST /api/v1/dry-run`

```json
{ "query": {
  "measures": ["SemanticEvents.count"],
  "dimensions": ["SemanticEvents.dimensions.store_format"]
} }
```

**Response** `200` — `normalizedQueries[0]` *(verified)*

```json
{
  "dimensions": ["SemanticEvents.dim_value_a"],
  "filters": [
    { "member": "SemanticEvents.dim_key_a", "operator": "equals", "values": ["store_format"] },
    { "member": "SemanticEvents.partition", "operator": "equals", "values": ["somi.is"] },
    { "member": "SemanticEvents.partition", "operator": "equals", "values": ["somi.is"] }
  ]
}
```

The partition predicate appears **twice on purpose** — two independent layers enforce it,
on top of the literal baked into each member's generated SQL:

| Layer | Where | Covers |
|---|---|---|
| Baked scope literal | Generated member SQL | Every query, always |
| Pre-processor injection | Before validation (REST) | REST `/load`, `/sql`, `/dry-run` |
| Rewrite-rules backstop | Gateway `queryRewrite` | REST **and** SQL API |

Team identity comes from the caller's own JWT, cross-checked against the requested
datasource — a caller can never receive another partition's member map, even if two teams
share a partition value. Any resolution failure passes the request straight to the
gateway's own auth, unchanged (fail-open to gateway auth, never fail-open to data).

---

## 7. JSON & the SQL API

ClickHouse `JSON` columns are discoverable too — discovery lists each path with its
dominant type and a typed access form. Because JSON explodes far wider than maps, JSON
members are **registry-only**: a template declares the hot paths with an explicit cast,
and everything else stays reachable through the SQL API.

**Registry member (template YAML):**

```yaml
- name: help_topic
  sql: "toString({CUBE}.properties.user_needed_help_with)"
  type: string
  meta:
    from_template: true
    registry_path: "properties.user_needed_help_with (string)"
```

**SQL API — arbitrary keys, no slots.** The SQL API applies the same tenant scoping via
`query_rewrite_rules` and lets you write map/JSON access directly — the right tool for BI
clients and open-ended exploration:

```sql
SELECT dimensions['store_format'] AS format, measure(count)
FROM   semantic_events
WHERE  event = 'Sales Report Submitted'
GROUP  BY 1
ORDER  BY 2 DESC;

-- JSON path with an explicit cast
SELECT toString(properties.user_needed_help_with) AS topic, measure(count)
FROM   semantic_events
GROUP  BY 1;
```

> **Always access map/JSON values by element with an explicit type — never select a whole
> map column.** The driver serializes whole-map values incorrectly; element access with a
> scalar result is always safe (and is exactly what the slots generate).

---

## 8. Reference

### Dynamic syntax

| Reference | Resolves to | Notes |
|---|---|---|
| `Cube.dimensions.KEY` | string dimension | slot value member + key filter |
| `Cube.flags.KEY` | boolean dimension | boolean map slot |
| `Cube.metrics.KEY` | measure (sum) | numeric map slot |
| `Cube.metrics.KEY.avg` | measure (avg) | same slot, avg variant |
| `Cube.properties.PATH` | typed dimension | registry-declared JSON path |

### Default slot layout

| Map | Slots | Kind | Aggregations |
|---|---|---|---|
| `dimensions` | 2 | dimension | — |
| `metrics` | 2 | measure | sum, avg |
| `flags` | 1 | boolean dimension | — |

Slot count and aggregations are template decisions — raising them is a reviewed change,
not an automatic reaction.

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/meta/dynamic` | Discover available map keys & JSON paths |
| `POST /api/v1/load` | Run a query (dynamic refs rewritten pre-validation) |
| `POST /api/v1/dry-run` | Inspect the rewritten, scoped query |

### Error codes

| Code | Meaning | Fix |
|---|---|---|
| `DYNAMIC_KEY_SLOTS_EXHAUSTED` | More distinct keys of one map than slots | Split query, use curated model, or SQL API |
| `DEFAULT_MODEL_MEMBER_UNAVAILABLE` | Referenced a member the team's variant lacks | Discover valid keys first (§1) |

### Configuration

| Env var | Default | Purpose |
|---|---|---|
| `DYNAMIC_META_TTL_MS` | `120000` | Discovery directory cache TTL (ms) |
| `DYNAMIC_META_SAMPLE_VALUES` | `5` | Max sample values per discovered property |

---

*All requests and responses above were executed against the running dev stack (ClickHouse
26.6) on 2026-07-07; response bodies are copied verbatim (numbers rounded for display where
noted). A styled, browsable version of this guide is also available as a shared Artifact.*
