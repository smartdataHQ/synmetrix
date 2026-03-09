# Cube Advanced/Internal Expression Support and SQL-API Paths

## Purpose

This is a focused addendum to the earlier Cube + ClickHouse location-selector research. It answers a narrower question:

> What advanced or internal expression paths exist in the installed Cube source, and do any of them materially change the conclusion about dynamic/function-like members for Synmetrix?

Scope of this addendum:

- `memberExpressions` flags
- `SqlFunction` and `PatchMeasure`
- where expressions are accepted or rejected
- evidence for REST, GraphQL, SQL API, and CubeSQL paths

Environment:

- Synmetrix installed Cube packages: `@cubejs-backend/* 1.6.19`
- Source: [services/cubejs/package.json](/Users/stefanbaxter/Development/synmetrix/services/cubejs/package.json)

---

## Executive Summary

The installed Cube source does contain an advanced member-expression mechanism.

That mechanism includes:

- a `memberExpressions` request flag
- two expression types:
  - `SqlFunction`
  - `PatchMeasure`
- parser and evaluator logic in the API gateway

However, the important practical finding is this:

- the normal public REST `/v1/load` path does **not** enable member expressions
- the GraphQL path uses `load()`, so it also does **not** enable member expressions
- the public HTTP `/v1/sql` route also does **not** enable member expressions
- the SQL-server / SQL-API path **does** enable member expressions internally

So there is an internal/advanced expression facility, but it does **not** overturn the main conclusion for Synmetrix's normal REST/GraphQL model usage.

It is still not evidence that Cube natively supports model-defined function calls like:

- `location('Vehicle').label`
- `location.Vehicle.label`

---

## Finding 1: `memberExpressions` exists as an internal request capability

The installed request types include an optional `memberExpressions?: boolean`.

Source:

- [request.d.ts:113](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts#L113)
- [request.d.ts:123](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts#L123)

This means the gateway is capable of being told to allow member-expression parsing in some request flows.

Important nuance:

- this is an internal gateway request contract
- it is not, by itself, proof that the public HTTP APIs expose or support it

---

## Finding 2: Cube implements two member-expression types: `SqlFunction` and `PatchMeasure`

The query parser defines:

- `SqlFunction`
- `PatchMeasure`

Source:

- [query.js:64](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L64)
- [query.js:69](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L69)
- [query.js:73](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L73)
- [query.js:83](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L83)

### `SqlFunction`

Input shape:

```json
{
  "cubeName": "SomeCube",
  "alias": "some_alias",
  "expr": {
    "type": "SqlFunction",
    "cubeParams": ["SomeCube.some_member"],
    "sql": "..."
  }
}
```

### `PatchMeasure`

Input shape:

```json
{
  "cubeName": "SomeCube",
  "alias": "patched_measure",
  "expr": {
    "type": "PatchMeasure",
    "sourceMeasure": "SomeCube.original_measure",
    "replaceAggregationType": "...",
    "addFilters": [...]
  }
}
```

Conclusion:

- Cube does have a rich internal expression object format.
- But it is limited to specific expression kinds.
- This is not the same thing as general model-defined functions or arbitrary runtime member creation.

---

## Finding 3: Expressions are parsed from JSON-like string payloads, not from model/member syntax

The gateway checks for query members that are strings beginning with `{`, then parses them as member-expression payloads.

Source:

- [gateway.js:972](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L972)
- [gateway.js:981](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L981)
- [gateway.js:998](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L998)
- [gateway.js:1004](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1004)
- [query.js:232](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L232)

Implementation detail:

- `SqlFunction` is converted into a JS function body using `Function.constructor`
- `PatchMeasure` filters are converted similarly

Source:

- [gateway.js:1036](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1036)
- [gateway.js:1058](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1058)

Conclusion:

- This is an advanced query-expression mechanism.
- It is not user-facing function syntax.
- It does not imply support for `location('Vehicle').label`.

---

## Finding 4: The query schema technically accepts member-expression alternatives more broadly than the product routes use them

`querySchema` includes alternatives for member expressions in:

- `measures`
- `dimensions`
- `segments`

Source:

- [query.js:136](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L136)

There is also an explicit TODO:

- `TODO add member expression alternatives only for SQL API queries?`

This comment is important because it shows intent:

- the schema parser can technically accept them
- but even in Cube's own source, they are treated as something that probably belongs only to SQL API queries

Conclusion:

- parser-level acceptance is broader than route-level support
- this reinforces that these expressions are an advanced/internal feature, not a general supported query surface

---

## Finding 5: Public REST `/v1/load` does not enable member expressions

The public `/v1/load` GET/POST handlers call `this.load(...)` with:

- `query`
- `context`
- `res`
- `queryType`

They do **not** pass `memberExpressions`.

Source:

- [gateway.js:172](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L172)
- [gateway.js:181](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L181)

`load()` then calls:

```js
this.getNormalizedQueries(query, context)
```

with no fourth argument, which means `memberExpressions = false`.

Source:

- [gateway.js:1320](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1320)
- [gateway.js:1333](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1333)
- [gateway.js:861](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L861)

When an expression is present and `memberExpressions` is false, Cube throws:

- `Expressions are not allowed in this context`

Source:

- [gateway.js:883](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L883)
- [gateway.js:884](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L884)

Conclusion:

- Normal REST data queries do not support member expressions in practice.

---

## Finding 6: GraphQL also does not enable member expressions

Cube's GraphQL resolver converts GraphQL to a JSON query, then calls:

```js
apiGateway.load({ ... apiType: 'graphql' })
```

Source:

- [graphql.js:548](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js#L548)

Because GraphQL uses `load()`, and `load()` does not enable `memberExpressions`, GraphQL inherits the same restriction as REST `/v1/load`.

Conclusion:

- GraphQL does not provide a hidden path for expression-based function-like members.

---

## Finding 7: Public HTTP `/v1/sql` also does not enable member expressions

The public `/v1/sql` GET/POST handlers call `this.sql(...)` with:

- `query`
- `context`
- `res`

They do **not** pass `memberExpressions`.

Source:

- [gateway.js:197](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L197)
- [gateway.js:214](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L214)

`sql()` accepts `memberExpressions`, but only if the caller passes it explicitly:

- [gateway.js:949](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L949)
- [gateway.js:953](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L953)

Conclusion:

- The public HTTP SQL-generation route is not an expression-enabled loophole.

---

## Finding 8: SQL-server / SQL-API paths explicitly enable member expressions

The SQL server code calls the gateway with `memberExpressions: true` in two key places:

- `sqlApiLoad(...)`
- `sql(...)`

Source:

- [sql-server.js:173](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L173)
- [sql-server.js:201](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L201)

This is the clearest evidence that advanced member expressions are intended for SQL-server / SQL-API flows.

Conclusion:

- There is a real internal/advanced expression path.
- It is routed through SQL-server infrastructure, not the ordinary REST/GraphQL model-consumption path.

---

## Finding 9: `PatchMeasure` is not function-like lookup; it is a measure rewrite mechanism

`PatchMeasure` is wired into `BaseMeasure` and prepares a patched measure derived from an existing source measure.

Source:

- [BaseMeasure.js:100](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseMeasure.js#L100)

Practical meaning:

- `PatchMeasure` is for measure transformation/augmentation
- it is not a generic way to define a function-like dynamic dimension accessor

Conclusion:

- `PatchMeasure` does not materially help the `location('Vehicle').label` problem.

---

## Finding 10: `SqlFunction` is closer to inline SQL than to model-defined functions

`SqlFunction` lets an expression object carry:

- `cubeParams`
- a SQL template string

The gateway turns this into executable JS that returns SQL text.

What it appears useful for:

- ad hoc SQL pushdown-style expression members
- advanced SQL server / SQL API workflows

What it is not:

- a reusable model-defined function exposed to end users
- a general parameterized member name mechanism
- proof that normal REST/GraphQL clients can call custom functions

Conclusion:

- `SqlFunction` is powerful, but it is still not the same as first-class function exposure in Cube models.

---

## Finding 11: Pre-aggregation support is path-specific, not uniformly disabled

This matters because one earlier claim was:

> “True query-time dynamic lookup ... is possible via CTE + FILTER_PARAMS but doesn't support pre-aggregations ...”

The installed source does **not** support that as a universal statement.

### Evidence

The SQL-server `sql(...)` path sets:

- `disableExternalPreAggregations: true`

Source:

- [sql-server.js:201](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js#L201)

But `sqlApiLoad(...)` does **not** blanket-disable pre-aggregations. Instead, `sqlApiLoad()` passes through to `getSqlQueriesInternal(...)` with:

```js
disableExternalPreAggregations: request.sqlQuery
```

Source:

- [gateway.js:1386](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1386)
- [gateway.js:1403](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L1403)

Interpretation:

- some SQL-server expression flows explicitly disable external pre-aggregations
- other SQL-API flows do not appear to do so universally

Conclusion:

- it is not accurate to claim, categorically from the installed source, that all advanced expression paths “don't support pre-aggregations”
- pre-aggregation behavior depends on which path is being used

---

## Finding 12: There is no evidence here of model-defined user-callable functions

Across the inspected installed source, there is support for:

- compile-time model generation (`asyncModule`, `COMPILE_CONTEXT`)
- runtime filter parameter injection (`FILTER_PARAMS`)
- advanced member-expression objects (`SqlFunction`, `PatchMeasure`)
- SQL-server / SQL-API expression-enabled paths

There is **not** evidence of:

- model-defined functions that can be called from a query like `foo('x')`
- arbitrary parameterized member names
- native support for `location('Vehicle').label`
- native support for `location.Vehicle.label`

Conclusion:

- advanced expression support exists
- function-style query syntax still does not appear to be a supported Cube model feature

---

## Path-by-Path Matrix

### 1. REST `/v1/load`

- Uses `load()`
- Does not pass `memberExpressions`
- Expression payloads are rejected

Status:

- static members only

### 2. GraphQL

- Converts GraphQL to JSON query
- Calls `load()`
- Inherits the same restriction as REST load

Status:

- static members only

### 3. Public HTTP `/v1/sql`

- Calls `sql()`
- Does not pass `memberExpressions`

Status:

- not expression-enabled in the public route

### 4. SQL-server / SQL API internals

- Calls `sqlApiLoad()` / `sql()` with `memberExpressions: true`

Status:

- expression-enabled
- advanced/internal path

### 5. CubeSQL (`/v1/cubesql` and SQL server)

- Executes through SQL-server machinery
- strong evidence this is the main expression-enabled area
- still not evidence of model-defined function syntax

Status:

- most flexible path found
- still not equivalent to native dynamic model functions

---

## Refined Conclusion

The earlier broad statement should be tightened.

### What is true

- Cube has advanced/internal expression support.
- That support includes `SqlFunction` and `PatchMeasure`.
- It is associated with SQL-server / SQL-API paths.
- It is not broadly enabled on normal REST/GraphQL paths used by Synmetrix.

### What is false or overstated

- It is not established that “true query-time dynamic lookup” in the sense of a native query syntax like `location('Vehicle').label` is supported.
- It is not established that all such advanced paths categorically “don't support pre-aggregations.”

### Best accurate statement

> The installed Cube source has an advanced member-expression mechanism (`SqlFunction`, `PatchMeasure`) that is enabled on SQL-server / SQL-API paths but not on the normal REST or GraphQL paths. This is closer to ad hoc SQL/member-expression support than to native model-defined functions, and it does not provide evidence that selectors like `location('Vehicle').label` are supported as first-class Cube syntax.

---

## Sources

### Local installed Cube source

- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/sql-server.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/graphql.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/types/request.d.ts)
- [services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseMeasure.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/adapter/BaseMeasure.js)

### Related official docs already cross-checked

- Cube querying docs:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/queries
- Cube REST API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/query-format
