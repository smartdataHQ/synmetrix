# Cube Advanced Expression Support and SQL API Research

> Superseded by `2026-03-09-cube-clickhouse-location-selector-consolidated.md`.

## Scope

This document is a focused addendum to the earlier `location` selector research. It answers a narrower question:

> Are there any advanced or internal Cube paths that would allow function-like, parameterized, or dynamic member behavior beyond the normal REST / GraphQL semantic-query model?

This document is explicitly scoped to:

- Cube as used inside Synmetrix
- ClickHouse as the backing database
- the `semantic_events`-style nested/grouped location structure already profiled locally

It is **not** a general statement about every Cube backend. Some of the SQL-level feasibility discussed here depends directly on ClickHouse features such as nested structures, array functions, and `ARRAY JOIN`.

This includes:

- documented SQL API paths
- SQL API over HTTP
- internal `memberExpressions` support
- `SqlFunction` / `PatchMeasure`
- `expressionParams`
- whether any of this changes the answer for selectors like `location('Vehicle').label`

Research date: 2026-03-09

Environment researched:

- Synmetrix Cube packages: `@cubejs-backend/* 1.6.19`
- local source in `services/cubejs/node_modules`

---

## Executive Summary

There are three distinct layers to understand:

1. **Normal semantic query path**
   - REST `/v1/load`
   - GraphQL `cube` query
   - Synmetrix’s current smart-model usage
   - This path still requires static members and does not support native function-like selectors.

2. **Documented SQL API**
   - Public and supported.
   - Lets users write SQL against cube tables and columns.
   - Supports outer `SELECT`, `CASE`, and CTE-based patterns via query pushdown.
   - Useful for advanced ad hoc SQL, but not the same thing as exposing model-defined functions.

3. **Internal member-expression support**
   - Real in the installed source.
   - Uses `memberExpressions`, `SqlFunction`, `PatchMeasure`, and `expressionParams`.
   - Appears to be enabled on SQL-server-oriented paths, not the standard REST/GraphQL query routes.
   - I found no official Cube docs for this interface.
   - Treat it as internal/unstable unless Cube explicitly documents and supports it.

Bottom line:

- The earlier answer stands for Synmetrix’s normal path: no native model-defined query-time function such as `location('Vehicle').label`.
- However, there **are** advanced escape hatches:
  - documented SQL API queries, which are especially relevant on ClickHouse because the lookup logic itself is expressible in ClickHouse SQL
  - undocumented internal member-expression plumbing
- These are not equivalent to first-class semantic-model functions.

---

## Finding 1: The normal REST and GraphQL semantic query path still requires static members

The installed Cube validator still expects normal query members to be static identifiers:

- `cube.member`
- with an optional third segment only for time granularity

Local source:

- [query.js:46](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L46)
- [query.js:48](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L48)

The standard public HTTP and GraphQL routes use `load()` without enabling member expressions:

- REST `/v1/load` calls `load({ query, ... })`
- GraphQL resolver also calls `apiGateway.load({ query, ... })`

Local source:

- [gateway.js:172](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L172)
- [gateway.js:181](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L181)
- [graphql.js:552](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js#L552)
- [gateway.js:1336](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1336)

And `load()` internally calls `getNormalizedQueries(query, context)` without `memberExpressions`:

- [gateway.js:1336](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1336)

Conclusion:

- The normal Synmetrix path still does not support function-like or dynamic member names.

---

## Finding 2: There is a documented SQL API, and it is much more expressive than REST semantic queries

Cube’s official SQL API is documented and supported.

Primary source:

- SQL API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api/query-format

Key official points:

- SQL API runs queries in the Postgres dialect over cube tables and columns.
- Each cube/view is represented as a table.
- Measures, dimensions, and segments are represented as columns.
- SQL API supports regular queries, post-processing, and pushdown.

Relevant official lines:

- cube/view as table, members as columns: lines 708-714
- dimensions in `SELECT` / `GROUP BY`: lines 720-726
- measures via `MEASURE(...)`: lines 727-749
- SQL API supports regular queries, post-processing, and pushdown: lines 763-765

The docs also explicitly state that for more complex logic:

- not all expressions can be pushed down from a cube-table `SELECT`
- but an outer `SELECT` can use additional SQL expressions such as `CASE`
- CTEs can be used to achieve the same result

Relevant official lines:

- not all functions/expressions are supported in rewritten cube-table fragments: lines 795-796
- nested outer `SELECT` can use more SQL expressions: lines 809-829
- CTEs supported for the same result: line 830

Conclusion:

- Yes, Cube has a supported advanced path for SQL-level expression work.
- But that path is SQL-first, not “model-defined function invocation”.
- In this research, that matters specifically because ClickHouse can already express the `location_of` discriminator lookup in SQL.

---

## Finding 3: SQL API over HTTP is real and public

Cube officially introduced SQL API over HTTP using `/v1/cubesql`.

Primary source:

- Cube v1.5 changelog:
  - https://cube.dev/blog/cube-core-v1-5-performance-calendar-cubes-sql-api-over-http

Relevant official statement:

- “The SQL API was complemented with a new HTTP transport, supported by the `/v1/cubesql` API endpoint.”

Local Synmetrix source confirms the route exists:

- `/api/v1/cubesql` route:
  - [gateway.js:262](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L262)

In Synmetrix, Cube SQL API server support is enabled by default:

- [services/cubejs/index.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js)

Conclusion:

- Synmetrix does have a supported SQL-first escape hatch.
- That means a client could execute advanced SQL logic, including ClickHouse array operations, without relying on semantic member names.

Important limitation:

- This still does not create native semantic-model functions.
- It gives you advanced SQL access, not semantic selector syntax.

---

## Finding 4: There is a real internal member-expression system in the installed source

The installed Cube source contains a separate mechanism for “member expressions”.

Local evidence:

- `getNormalizedQueries(..., memberExpressions = false)`:
  - [gateway.js:861](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L861)
- if expressions are present and `memberExpressions` is false:
  - throws `Expressions are not allowed in this context`
  - [gateway.js:881](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L881)
- expression parsing and evaluation:
  - [gateway.js:981](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L981)
  - [gateway.js:1036](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1036)

The supported internal expression kinds are:

- `SqlFunction`
- `PatchMeasure`

Local source:

- [query.js:64](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L64)
- [query.js:69](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L69)
- [types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)

The query shape allows expression objects in:

- `measures`
- `dimensions`
- `segments`
- `subqueryJoins[].on`

Local source:

- [types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)
- [gateway.js:972](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L972)

Conclusion:

- There is more advanced machinery in Cube than the normal REST query docs show.
- This is not imaginary; it exists in the installed product.

---

## Finding 5: `SqlFunction` is function-like, but it is not the same as model-defined callable functions

`SqlFunction` works like an ad hoc expression member.

From local source:

- `parseMemberExpression()` parses a JSON object embedded in a string
- if `expr.type === 'SqlFunction'`, Cube turns it into a JS `Function`
- it uses `cubeParams` plus a SQL template string

Local source:

- [gateway.js:987](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L987)
- [gateway.js:1000](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1000)
- [gateway.js:1050](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1050)

The internal input type is:

```ts
type InputMemberExpressionSqlFunction = {
  type: 'SqlFunction';
  cubeParams: Array<string>;
  sql: string;
}
```

Local source:

- [types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)

What this appears to mean:

- you can inject an ad hoc expression member into a query
- the expression can reference cube parameters/member names
- the expression resolves to a named alias inside the query

What it does **not** mean:

- it does not define a reusable Cube model function
- it does not add new native syntax to the query language
- it does not make `location('Vehicle').label` a standard supported selector

Conclusion:

- `SqlFunction` is best understood as internal ad hoc expression injection, not semantic-model functions.

---

## Finding 6: `expressionParams` exist and likely provide parameter binding for expressions

The SQL path accepts `expressionParams`:

- [types/request.d.ts:111](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts#L111)
- [gateway.js:949](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L949)

Those are passed into the SQL compiler and the `ParamAllocator`:

- [gateway.js:954](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L954)
- [ParamAllocator.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/ParamAllocator.js)

What `ParamAllocator` does:

- stores expression parameters
- allocates placeholders
- rewrites annotated SQL into SQL + params arrays

Conclusion:

- There is indeed parameter plumbing for advanced expressions.
- So the statement “Cube has no parameter-based operations at all” would be false.
- But this is a lower-level SQL/expression mechanism, not end-user semantic-model function support.

---

## Finding 7: Internal member expressions are not enabled on the public semantic query routes

This is the most important practical limitation.

### Not enabled on:

- REST `/v1/load`
- GraphQL `cube`
- public `/v1/sql` route that returns generated SQL for semantic queries

Evidence:

- `/v1/load` calls `load()` without `memberExpressions`
  - [gateway.js:172](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L172)
- GraphQL resolver calls `apiGateway.load()` without `memberExpressions`
  - [graphql.js:552](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js#L552)
- `/v1/sql` route calls `sql()` without `memberExpressions`
  - [gateway.js:204](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L204)

### Enabled on:

- SQL-server-oriented paths in `sql-server.js`

Evidence:

- `sqlApiLoad(... memberExpressions: true ...)`
  - [sql-server.js:173](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L173)
- `sql(... memberExpressions: true ...)`
  - [sql-server.js:201](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L201)

Conclusion:

- The internal expression system is real but not generally available to the standard REST/GraphQL semantic query clients Synmetrix uses today.

---

## Finding 8: The internal expression system appears undocumented in official Cube docs

I explicitly searched official Cube documentation for:

- `memberExpressions`
- `SqlFunction`
- `PatchMeasure`
- `expressionParams`

I did not find an official Cube docs page documenting these as public user-facing APIs.

What I **did** find:

- public docs for SQL API query format
- public docs for dynamic models (`asyncModule`, Jinja)
- public docs for context variables (`FILTER_PARAMS`)

Conclusion:

- This strongly suggests `memberExpressions` are internal or at least not part of the normal supported documentation surface.
- Use them only with caution, because support guarantees are unclear.

This is an inference from the combination of:

- local source evidence
- absence from targeted official docs search

---

## Finding 9: Documented SQL API is powerful enough for advanced `location` logic without internal expressions

Since SQL API query format supports:

- cube tables as SQL tables
- outer `SELECT`
- `CASE`
- CTEs
- pushdown/post-processing

it can express sophisticated calculations even without undocumented `SqlFunction`.

Primary source:

- https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api/query-format

For example, conceptually, if the relevant location arrays are exposed appropriately, a SQL API query could perform:

```sql
WITH base AS (
  SELECT ...
  FROM semantic_events
)
SELECT
  ...,
  arrayFirstOrNull(
    (label, kind) -> kind = 'Vehicle',
    location_label,
    location_location_of
  ) AS vehicle_label
FROM base
```

Important caveat:

- this is SQL API usage, not semantic-model selector support
- it is ad hoc SQL against cube tables/columns, not a model-defined function callable from REST/GraphQL semantics
- this conclusion is specifically strong for ClickHouse because the nested-array lookup is naturally implementable there with `arrayFirstOrNull`, `arrayFilter`, `indexOf`, and `ARRAY JOIN`

---

## Finding 10: The statement “true query-time dynamic lookup is possible via CTE + FILTER_PARAMS” is still not a good description

After this deeper pass, the more precise answer is:

- **CTE**: yes, supported on the documented SQL API path
- **runtime parameterization**: yes, there are parameter mechanisms (`FILTER_PARAMS`, `expressionParams`)
- **true dynamic lookup as a semantic member selector**: still no on the normal semantic path

Why this claim is misleading:

1. `FILTER_PARAMS` are documented for SQL generation / predicate pushdown, not as a general semantic selector language.
2. CTEs belong to the SQL API path, not the semantic `cube.member` REST/GraphQL path.
3. `location('Vehicle').label` is still not a native semantic member syntax.
4. Internal `SqlFunction` support is source-visible, but not documented as a public feature and not enabled on the routes Synmetrix normally uses.

Better phrasing:

> Query-time parameterized SQL is possible in Cube through the documented SQL API and through internal expression mechanisms visible in source. However, this does not amount to first-class semantic-model function selectors on the standard REST/GraphQL path.

---

## Finding 11: I found no evidence for the blanket claim “doesn’t support pre-aggregations”

I did **not** find evidence supporting a blanket statement that these advanced paths “don’t support pre-aggregations”.

Reasons:

- SQL API query format is part of the main Cube query engine and docs discuss regular queries, post-processing, and pushdown, not an isolated no-pre-aggregation path.
- The normal load path logs `usedPreAggregations`.
- In local SQL generation code, `disableExternalPreAggregations: true` appears in some SQL-server paths, but that is not the same as disabling all pre-aggregations.

Local evidence:

- SQL path passes `disableExternalPreAggregations: true`
  - [sql-server.js:201](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L201)
- `BaseQuery` distinguishes external pre-aggregations specifically
  - [BaseQuery.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js)

Conclusion:

- I would not repeat the blanket claim “doesn’t support pre-aggregations” without narrower evidence.
- The safe statement is:
  - advanced SQL/expression paths may change how and when pre-aggregations can match,
  - but I did not verify a general prohibition.

---

## Finding 12: What all of this changes, and what it does not change

### What it changes

It weakens any absolute statement like:

> “Cube has no function-like or parameterized behavior at all.”

That absolute statement is false.

Cube does have:

- compile-time dynamic model generation
- documented SQL API for advanced SQL
- internal member-expression plumbing
- expression parameters

### What it does not change

It does **not** change the practical answer for Synmetrix’s semantic model and smart-model-builder path:

- no native `location('Vehicle').label`
- no native `location.Vehicle.label`
- no clean model-defined function API for semantic queries

The best supported options remain:

1. flattened `location` cube/view using `ARRAY JOIN`
2. compile-time generated static members such as `location_vehicle_label`
3. SQL API-based advanced querying for clients that are prepared to use SQL instead of semantic members

---

## Practical Recommendations

### If the requirement is semantic-model UX

Use:

- static generated members, or
- a flattened `location` cube/view

Do not rely on undocumented member expressions.

### If the requirement is power-user / AI / SQL-agent UX

Use SQL API:

- it is documented
- it supports outer queries and CTEs
- it can express the ClickHouse array lookup directly

This is the cleanest path for advanced ad hoc logic.

### If the requirement is experimentation

Internal `SqlFunction` / `expressionParams` may be worth prototyping only if:

- you control the calling path end to end
- you are willing to depend on undocumented behavior
- you accept upgrade risk

---

## Final Answer

After exhaustive review of the installed Cube source and official docs:

- **Yes**, Cube has advanced/internal expression support and SQL-specific paths.
- **Yes**, there are parameter-based mechanisms in Cube.
- **Yes**, SQL API can do much more than the normal REST semantic query path.
- **No**, this still does not amount to a supported native semantic-model function feature for selectors like `location('Vehicle').label` in Synmetrix’s normal ClickHouse usage.

The strongest supported escape hatch is the documented SQL API.
The strongest semantic-model answer is still static generated members or a flattened `ARRAY JOIN` cube.

---

## Source List

### Local Synmetrix / installed Cube sources

- [services/cubejs/package.json](/Users/stefanbaxter/Development/synmetrix/services/cubejs/package.json)
- [services/cubejs/index.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts)
- [services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/ParamAllocator.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/ParamAllocator.js)

### Official Cube sources

- SQL API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api/query-format
- Dynamic JavaScript models:
  - https://cube.dev/docs/product/data-modeling/dynamic/javascript
- Dynamic YAML/Jinja models:
  - https://cube.dev/docs/product/data-modeling/dynamic/jinja
- Context variables:
  - https://cube.dev/docs/product/data-modeling/reference/context-variables
- Types and formats:
  - https://cube.dev/docs/product/data-modeling/reference/types-and-formats
- REST API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/query-format
- Cube Core v1.5 changelog:
  - https://cube.dev/blog/cube-core-v1-5-performance-calendar-cubes-sql-api-over-http
