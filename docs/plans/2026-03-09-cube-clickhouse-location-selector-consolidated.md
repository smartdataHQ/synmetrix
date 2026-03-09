# Consolidated Research: Cube.dev + ClickHouse Dynamic Location Selectors

## Status

This is the canonical consolidated note for the March 9, 2026 research on dynamic location selectors in Synmetrix.

It supersedes:

- `2026-03-09-cube-clickhouse-dynamic-location-selector-research.md`
- `2026-03-09-cube-advanced-expression-and-sql-api-research.md`

Scope:

- Synmetrix
- Cube `1.6.19`
- ClickHouse backend
- the `semantic_events` nested/grouped `location` structure

---

## Question

Can Synmetrix expose something like:

- `location('Vehicle').label`
- `location.Vehicle.label`

where:

1. `location_of` is treated as the discriminator inside the nested location structure,
2. sibling `location.*` values are selected by that discriminator,
3. one match returns a scalar native value,
4. multiple matches return an array of the native value type?

---

## Main Findings

### 1. The `location` structure is a ClickHouse nested/grouped parallel-array structure

In local artifacts, `location` is not a Map and not a named tuple. It is a grouped family of parallel arrays such as:

- `location.location_of`
- `location.label`
- `location.country`
- `location.latitude`
- `location.longitude`

Local evidence:

- [semantic_events_profile.json:1207](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json#L1207)
- [semantic_events_profile.json:1238](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json#L1238)
- [semantic_events.yml:264](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml#L264)
- [semantic_events.yml:281](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml#L281)

Important implication:

- `location_of` and `label` are related by array position, not by built-in key lookup semantics.

### 2. ClickHouse can express the lookup directly in SQL

For ClickHouse, the desired lookup is feasible with array functions or `ARRAY JOIN`.

Examples:

Return all matching labels:

```sql
arrayFilter(
  (label, kind) -> kind = 'Vehicle',
  location.label,
  location.location_of
)
```

Return the first matching label:

```sql
arrayFirstOrNull(
  (label, kind) -> kind = 'Vehicle',
  location.label,
  location.location_of
)
```

Or index-based:

```sql
arrayElementOrNull(
  location.label,
  indexOf(location.location_of, 'Vehicle')
)
```

Primary ClickHouse sources:

- Nested data type:
  - https://clickhouse.com/docs/sql-reference/data-types/nested-data-structures/nested
- Array functions:
  - https://clickhouse.com/docs/sql-reference/functions/array-functions
- Tuple functions:
  - https://clickhouse.com/docs/sql-reference/functions/tuple-functions

So the hard part is not ClickHouse.

### 3. On the normal Cube semantic query path, member names are still static

Cube’s normal semantic query path expects static members like:

- `cube.member`

and only allows a third segment for time granularity.

Local source:

- [query.js:46](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L46)
- [query.js:48](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L48)

That means:

- `location('Vehicle').label` is not native Cube member syntax
- `location.Vehicle.label` is also not native Cube member syntax on the standard REST path

### 4. JavaScript models do not change the query-time limitation

Cube JavaScript models give:

- compile-time generation via `asyncModule()`
- tenant/context-aware generation via `COMPILE_CONTEXT`

Local source:

- [DataSchemaCompiler.js:415](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js#L415)
- [DataSchemaCompiler.js:440](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js#L440)

But they do not give:

- runtime member creation
- model-defined callable functions in the semantic query language
- native support for `location('Vehicle').label`

So JS models help generate static members or views, not dynamic selectors.

### 5. Cube does have advanced/internal expression machinery, but it is not the normal Synmetrix path

The installed Cube source includes:

- `memberExpressions`
- `SqlFunction`
- `PatchMeasure`
- `expressionParams`

Local evidence:

- [gateway.js:861](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L861)
- [gateway.js:881](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L881)
- [query.js:64](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L64)
- [types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)
- [types/request.d.ts:111](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts#L111)

Important nuance:

- this machinery is real
- it is more like ad hoc expression injection than model-defined user functions
- it is not enabled on the public semantic REST/GraphQL routes Synmetrix normally uses

For example:

- standard `/v1/load` and GraphQL `cube` route through `load()` without `memberExpressions`
- SQL-server-oriented paths enable `memberExpressions: true`

Local evidence:

- [gateway.js:172](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L172)
- [graphql.js:552](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js#L552)
- [sql-server.js:173](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L173)
- [sql-server.js:201](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L201)

Conclusion:

- there are advanced internals
- they do not materially change the answer for Synmetrix’s normal semantic-model path

### 6. Cube’s documented SQL API is the strongest supported escape hatch

Cube has a documented SQL API, including SQL API over HTTP and query pushdown / CTE-style advanced SQL usage.

Primary Cube sources:

- SQL API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api/query-format
- SQL API over HTTP:
  - https://cube.dev/blog/cube-core-v1-5-performance-calendar-cubes-sql-api-over-http

Local route evidence:

- `/api/v1/cubesql` exists in Synmetrix:
  - [gateway.js:262](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L262)

This matters because on ClickHouse, SQL API can express:

- outer `SELECT`
- `CASE`
- CTEs
- array functions

So if you need advanced query-time logic, SQL API is the cleanest supported path.

But:

- SQL API is SQL-first
- it is not the same thing as exposing semantic-model functions

### 7. `FILTER_PARAMS` and parameters exist, but they are not dynamic member names

There are parameter mechanisms in Cube:

- `FILTER_PARAMS`
- `expressionParams`

Those prove that Cube is not entirely “parameterless”.

But they do not provide:

- arbitrary query-time member creation
- native model-defined function calls
- true dynamic selectors on the normal semantic path

So this statement is too strong:

> “Cube has no way to expose functions or parameter-based operations at all”

The corrected statement is:

> Cube has parameterized SQL-generation and advanced expression paths, but not first-class semantic-model functions for normal REST/GraphQL querying.

### 8. For ClickHouse, `FILTER_PARAMS` inside field SQL is a practical simple solution

For ClickHouse, a static Cube field can use `FILTER_PARAMS` inside its SQL expression to perform discriminator-based lookup over the nested parallel arrays.

Conceptually:

```js
sql: `arrayElementOrNull(
  ${CUBE}.location.label,
  indexOf(
    ${CUBE}.location.location_of,
    ${FILTER_PARAMS.semantic_events.location_type.filter((v) => v)}
  )
)`
```

What this means:

- the member name is still static
- the discriminator value is supplied at query time through a normal filter
- ClickHouse performs the actual lookup with `indexOf(...)`
- the field behaves like a parameterized projection, not a dynamic member

Why this is credible in the installed Cube version:

- `FILTER_PARAMS` proxies can return a callable `__column()` representation, not just a simple string predicate
- the source explicitly mentions `FILTER_PARAMS` being used in dimension/measure SQL and handling recursion around that case

Local evidence:

- [BaseQuery.js:3564](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js#L3564)
- [BaseQuery.js:3602](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js#L3602)
- [BaseQuery.js:3624](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseQuery.js#L3624)
- [CubeEvaluator.js:318](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/CubeEvaluator.js#L318)

What this solution solves:

- query-time discriminator lookup for ClickHouse nested arrays
- without generating one member per discriminator value
- without requiring dynamic member names

What it does not solve:

- native `location('Vehicle').label` syntax
- native `location.Vehicle.label` syntax
- arbitrary query-time field creation

This is the right description of the pattern:

> static member + query-time parameterized ClickHouse lookup

This is not the same thing as:

> true dynamic semantic-model function support

### 9. The lookup must be designed as either first-match or all-matches

The `FILTER_PARAMS` solution still branches into two distinct design choices.

#### Scalar first-match projection

Use ClickHouse `indexOf(...)` plus `arrayElementOrNull(...)`.

Recommended form:

```sql
arrayElementOrNull(
  location.label,
  indexOf(location.location_of, discriminator)
)
```

Important note:

- `arrayElementOrNull` is safer than `arrayElement`
- `indexOf(...)` returns `0` when no match is found

This yields:

- one scalar value when a match exists
- `NULL` when there is no match
- first match only when duplicates exist

#### All-matches projection

Use ClickHouse `arrayFilter(...)`.

Example:

```sql
arrayFilter(
  (label, kind) -> kind = discriminator,
  location.label,
  location.location_of
)
```

This yields:

- an array of matching values

### 10. The scalar-or-array requirement is not a good fit for Cube dimensions

Cube dimensions have a fixed type. A single dimension is not a good place to return:

- scalar native value for one row
- array native value for another row

This is the wrong shape for stable semantic modeling.

Practical consequence:

- do not design one member that changes between scalar and array
- instead expose separate scalar and array-like projections, or flatten the structure into rows

---

## Final Answer

For Synmetrix on ClickHouse:

- **ClickHouse can do the discriminator lookup** over `location.*` arrays.
- **Cube’s normal semantic query path cannot expose native function-style selectors** like `location('Vehicle').label` or `location.Vehicle.label`.
- **JavaScript models do not change that**; they only help generate static members or views at compile time.
- **A static field using `FILTER_PARAMS` inside field SQL is a practical ClickHouse-specific solution** for query-time discriminator lookup.
- **Advanced/internal Cube expression paths exist**, but they are not the standard supported semantic-model interface and are not enabled on Synmetrix’s normal REST/GraphQL routes.
- **The strongest supported advanced path is Cube SQL API**, which can leverage ClickHouse SQL directly.

---

## What Is Actually Implementable

### Simplest practical solution

Create static selector-style fields that use `FILTER_PARAMS` in field SQL against ClickHouse nested arrays.

Examples:

- `selected_location_label`
- `selected_location_country`
- `selected_location_latitude`
- `selected_location_longitude`

paired with a filter member such as:

- `location_type`

This gives:

- one reusable field per sibling property
- runtime selection of the discriminator
- no need to explode one member per discriminator value

Recommended semantics:

- scalar “first match” fields by default
- optional separate “all matches” fields if needed

### Best semantic-model option

Build a flattened `location` cube/view using ClickHouse `ARRAY JOIN` and filter by `location_of`.

Why:

- best fit for the real data shape
- preserves native scalar typing
- handles multiple matches as multiple rows instead of mixed scalar/array return types

### Best fallback semantic-model option

Generate static discriminator-specific members at compile time, for example:

- `location_vehicle_label`
- `location_origin_label`
- `location_vehicle_country`
- `location_vehicle_latitude`

using:

- Jinja-generated YAML, or
- JavaScript `asyncModule()`

This is still useful if:

- the set of discriminator values is very small and stable
- you want fully explicit members like `location_vehicle_label`
- you do not want selector filters

### Best power-user option

Use Cube SQL API for advanced ad hoc logic on ClickHouse.

That is the right place for:

- CTEs
- outer `SELECT`
- complex ClickHouse array operations

But it is a SQL interface, not a semantic selector API.

---

## Source Index

### Local Synmetrix / installed Cube

- [services/cubejs/package.json](/Users/stefanbaxter/Development/synmetrix/services/cubejs/package.json)
- [services/cubejs/index.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/index.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/query.d.ts)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts)
- [services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js)
- [services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/ParamAllocator.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/ParamAllocator.js)
- [test-output/semantic_events_profile.json](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json)
- [test-output/semantic_events.yml](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml)

### Official sources

- ClickHouse Nested docs:
  - https://clickhouse.com/docs/sql-reference/data-types/nested-data-structures/nested
- ClickHouse array functions:
  - https://clickhouse.com/docs/sql-reference/functions/array-functions
- ClickHouse tuple functions:
  - https://clickhouse.com/docs/sql-reference/functions/tuple-functions
- Cube REST API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/query-format
- Cube SQL API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/sql-api/query-format
- Cube dynamic JavaScript models:
  - https://cube.dev/docs/product/data-modeling/dynamic/javascript
- Cube dynamic YAML/Jinja models:
  - https://cube.dev/docs/product/data-modeling/dynamic/jinja
- Cube context variables:
  - https://cube.dev/docs/product/data-modeling/reference/context-variables
- Cube types and formats:
  - https://cube.dev/docs/product/data-modeling/reference/types-and-formats
- Cube SQL API over HTTP announcement:
  - https://cube.dev/blog/cube-core-v1-5-performance-calendar-cubes-sql-api-over-http
