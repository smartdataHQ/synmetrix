# Cube.dev + ClickHouse Research: Dynamic Location Selectors

> Superseded by `2026-03-09-cube-clickhouse-location-selector-consolidated.md`.

## Purpose

Research whether Cube.dev models can support dynamic nested-field selectors over ClickHouse data for the `semantic_events` table in Synmetrix, specifically patterns like:

- `location('Vehicle').label`
- `location.Vehicle.label`

The required semantics are:

1. Recognize `location_of` as the discriminator inside the nested `location` structure.
2. Filter sibling `location.*` arrays by that discriminator.
3. Return the native scalar type when exactly one match exists.
4. Return the native array type when multiple matches exist.

This document records all findings from local Synmetrix code/artifacts and primary Cube.dev / ClickHouse sources.

---

## Environment Researched

- Synmetrix Cube package version: `@cubejs-backend/* 1.6.19`
- Source: `services/cubejs/package.json`
- Cube docs version shown on the researched docs pages: `1.6.19`
- Research date: 2026-03-09

---

## Executive Summary

Short answer:

- ClickHouse can express the discriminator lookup in SQL over the `location` nested structure.
- Cube.dev cannot expose truly dynamic member names at query time on the normal REST / GraphQL path used by Synmetrix.
- Cube.dev can generate members dynamically at compile time, but they still become static members after compilation.
- A single Cube dimension cannot cleanly change its runtime type from scalar to array depending on row contents.

Implications:

- `location('Vehicle').label` is not a native Cube query/member syntax.
- `location.Vehicle.label` is also not a native Cube query/member syntax on the REST API path.
- The best practical options are:
  - generate static members per discriminator value at compile time, or
  - flatten `location` with `ARRAY JOIN` into a dedicated cube/view and filter by `location_of`.

---

## Finding 1: In Synmetrix, `location` is a ClickHouse grouped/nested structure, not a map or named tuple

Local artifacts show that `location` is represented as a family of grouped child columns:

- `location.location_of`
- `location.label`
- `location.country`
- `location.country_code`
- `location.code`
- `location.region`
- `location.division`
- `location.municipality`
- `location.locality`
- `location.postal_code`
- `location.postal_name`
- `location.street`
- `location.street_nr`
- `location.address`
- `location.longitude`
- `location.latitude`
- `location.geohash`
- `location.duration_from`
- `location.duration_until`

Evidence from local profiling output:

- [`test-output/semantic_events_profile.json`](../../test-output/semantic_events_profile.json)
  - `location.location_of` is `Array(LowCardinality(String))`, `columnType: "GROUPED"`, `parentName: "location"`, `childName: "location_of"`
  - `location.label` is also `Array(LowCardinality(String))`, `columnType: "GROUPED"`, `parentName: "location"`
  - `location_of` has low-cardinality values such as `Destination`, `Dropoff`, `Origin`, `POI`, `Pickup`, `Trip`, `Vehicle`
  - both `location.location_of` and `location.label` show `maxArrayLength: 2`

Concrete local references:

- [semantic_events_profile.json:1207](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json#L1207)
- [semantic_events_profile.json:1238](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json#L1238)

Evidence from generated Cube YAML:

- [`test-output/semantic_events.yml`](../../test-output/semantic_events.yml) exposes these as separate dimensions:
  - `location_location_of` -> `sql: "{CUBE}.location.location_of"`
  - `location_label` -> `sql: "{CUBE}.location.label"`

Concrete local references:

- [semantic_events.yml:264](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml#L264)
- [semantic_events.yml:281](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml#L281)

Conclusion:

- `location_of` is the discriminator-like child.
- The relationship between `location_of` and `label` is positional inside parallel arrays.
- The current smart-generated model does not implement lookup semantics between them.

---

## Finding 2: ClickHouse dot notation on nested structures is shorthand for parallel arrays, not key-based lookup

ClickHouse documents `Nested(...)` as a set of multiple same-length column arrays:

- "It is easiest to think of a nested data structure as a set of multiple column arrays of the same length."
- The only place where a query can refer to the whole nested structure by name is `ARRAY JOIN`.
- You cannot `SELECT` the whole nested structure directly; you must select individual child columns.

Primary source:

- ClickHouse Nested docs: https://clickhouse.com/docs/sql-reference/data-types/nested-data-structures/nested

Relevant lines:

- `Nested` is multiple arrays of the same length: lines 268-270
- whole-structure name allowed only in `ARRAY JOIN`: lines 270-276
- whole nested structure cannot be selected directly: line 291

What this means here:

- `location.label` and `location.location_of` are separate arrays.
- `location.label` does not automatically mean "the label whose `location_of` is X".
- Any lookup by discriminator must be expressed explicitly with array functions or by `ARRAY JOIN`.

---

## Finding 3: ClickHouse named tuple access is static, not dynamic

The user's note about tuple access is correct for named tuples:

- `tupleElement` can extract by index or by name.
- The named element accessor works only for named tuples.
- The element name must be a constant string.
- The docs say all arguments must be constants.

Primary source:

- ClickHouse tuple functions: https://clickhouse.com/docs/sql-reference/functions/tuple-functions

Relevant lines:

- `tupleElement` extracts by index or name: lines 394-400
- name access works only for named tuples: line 400
- all arguments must be constants: line 403
- name argument is `const String`: line 414

Conclusion:

- Even if `location` were a named tuple, dynamic tuple-field names would still not be the right mechanism here.
- The desired problem is not "pick tuple field by runtime field name"; it is "filter a nested array of sibling values by a discriminator array".

---

## Finding 4: ClickHouse can express the required lookup logic in SQL

ClickHouse array functions are strong enough to implement the discriminator lookup directly.

Primary sources:

- Array functions: https://clickhouse.com/docs/sql-reference/functions/array-functions

Relevant functions:

- `arrayFilter` returns all matching elements from a source array and can use additional condition arrays
- `arrayFirst` returns the first matching element
- `arrayFirstOrNull` returns the first matching element or `NULL`
- `indexOf` returns the index of the first matching discriminator value
- `arrayElementOrNull` can fetch an element by index and return `NULL` out of bounds

Relevant lines:

- `arrayFilter` with multiple arrays: lines 1042-1059
- `arrayFirst`: lines 1078-1094
- `arrayFirstOrNull`: lines 1147-1166
- `indexOf`: lines 3564-3582
- `arrayElementOrNull`: lines 651-692

### Example SQL patterns that should work in ClickHouse

Return all matching labels as an array:

```sql
arrayFilter(
  (label, kind) -> kind = 'Vehicle',
  location.label,
  location.location_of
)
```

Return the first matching label as a nullable scalar:

```sql
arrayFirstOrNull(
  (label, kind) -> kind = 'Vehicle',
  location.label,
  location.location_of
)
```

Equivalent index-based scalar lookup:

```sql
arrayElementOrNull(
  location.label,
  indexOf(location.location_of, 'Vehicle')
)
```

The same pattern can be applied to:

- `location.country`
- `location.longitude`
- `location.latitude`
- other sibling `location.*` arrays

Conclusion:

- The lookup is feasible in ClickHouse SQL.
- The limitation is not ClickHouse's ability to compute it.
- The limitation is how Cube exposes members and types.

---

## Finding 5: Cube REST API member names are static `cube.member` identifiers

Cube's REST query format defines query members as `cube_name.member_name`, with an optional third segment only for time granularities.

Primary source:

- Cube REST API query format: https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/query-format

Relevant lines:

- query members are `measures`, `dimensions`, `segments`: line 723
- query member format is `cube_name.member_name`: line 725
- optional third segment is only for time granularity: line 726

The installed Synmetrix Cube source confirms the restriction at validation level:

- `id` must match `^[a-zA-Z0-9_]+\.[a-zA-Z0-9_]+$`
- `dimensionWithTime` allows a third segment only for time dimensions

Local source:

- [query.js:46](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L46)
- [query.js:48](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L48)

Conclusion:

- `location.Vehicle.label` is not compatible with the standard REST member naming contract.
- `location('Vehicle').label` is also not compatible with the member naming contract.
- To support either syntax, Synmetrix would need an application-layer parser that rewrites the custom syntax before sending a valid Cube query, and the rewritten target would still need to be a static Cube member or a special SQL-API-only expression path.

---

## Finding 6: Cube supports dynamic model generation, but only at compile time

Cube has two relevant dynamic-modeling mechanisms:

1. JavaScript `asyncModule()`
2. YAML + Jinja + Python

### JavaScript dynamic models

Cube docs explicitly state:

- this works only for JavaScript models, not YAML
- `asyncModule()` runs during data model compilation
- each `asyncModule()` call runs once per compilation
- `COMPILE_CONTEXT` can be used to vary generated members per `context_to_app_id`

Primary source:

- Cube dynamic JavaScript models: https://cube.dev/docs/product/data-modeling/dynamic/javascript

Relevant lines:

- JS only, not YAML: line 698
- `asyncModule()` allows data models to be created on the fly: line 701
- invoked once per data model compilation: line 703
- `COMPILE_CONTEXT` usage with multi-tenant dynamic models: lines 812-855

### YAML dynamic models

Cube docs also state:

- Jinja is supported in YAML data model files
- Jinja loops can generate repeated dimensions/measures
- YAML can dynamically generate models from a remote source, but it still results in compiled static output

Primary source:

- Cube dynamic YAML/Jinja docs: https://cube.dev/docs/product/data-modeling/dynamic/jinja

Relevant lines:

- dynamic models with YAML/Jinja/Python: lines 704-708
- Jinja loops generating repeated definitions: lines 734-776

### Synmetrix-specific implication

Synmetrix currently serves data schema files through `repositoryFactory`, and the mapper simply returns whatever file name and contents are stored:

- [repositoryFactory.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/repositoryFactory.js)
- [mapSchemaToFile.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/mapSchemaToFile.js)

So in principle Synmetrix could store:

- `.yml` models using Jinja-generated static members, or
- `.js` models using `asyncModule()`

However, both approaches are compile-time generation, not query-time dynamic member creation.

Conclusion:

- Cube can dynamically generate members like `location_vehicle_label`, `location_origin_label`, etc.
- Cube cannot create brand-new member names on the fly per query on the normal REST/GraphQL path.

---

## Finding 7: `FILTER_PARAMS` are not dynamic member names; they are predicate-pushdown parameters

Cube's `FILTER_PARAMS` context variable:

- lets SQL generation see query filter values
- is intended for optimizer hints / partition pushdown
- is considered bad practice when heavily used
- must be a top-level expression in `WHERE`

Primary source:

- Cube context variables: https://cube.dev/docs/product/data-modeling/reference/context-variables

Relevant lines:

- purpose and warning: lines 787-792
- must be a top-level `WHERE` expression: line 793
- syntax examples: lines 793-817 and 934-976

Conclusion:

- `FILTER_PARAMS` can pass a runtime value such as `'Vehicle'`.
- But it cannot create or select a dynamic member name.
- And it is not a good fit for embedding lookup logic inside a dimension definition.

Practical interpretation:

- A static member like `selected_location_label` might be possible in a custom cube SQL layer, but only as a fixed predeclared member.
- That still does not give native `location('Vehicle').label` or `location.Vehicle.label` semantics in Cube's query language.

---

## Finding 8: Cube has a limited expression path, but Synmetrix's normal path does not expose it

The installed Cube source contains support for `SqlFunction` member expressions:

- query schema includes `SqlFunction`
- gateway checks for expressions in the query
- if expressions are not enabled in that context, Cube throws:
  - `Expressions are not allowed in this context`

Local source:

- [query.js:64](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L64)
- [query.js:69](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js#L69)
- [gateway.js:884](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js#L884)

Cube docs also separate query types by API:

- query pushdown and post-processing are SQL API only
- regular REST/GraphQL queries use model members

Primary source:

- Cube querying docs: https://cube.dev/docs/product/apis-integrations/core-data-apis/queries

Relevant lines:

- SQL API only for query with post-processing: line 737
- SQL API only for query with pushdown: line 738
- REST/GraphQL regular queries use listed dimensions/measures: lines 744-751

Conclusion:

- There is an escape hatch in some Cube contexts for custom SQL-like expressions.
- That is not the normal, stable contract for Synmetrix's smart-generated models and REST/GraphQL usage.
- It should not be considered a solution for the builder UX requested here.

---

## Finding 9: Cube dimensions have a single fixed type; array-or-scalar union behavior is not a normal fit

Cube's documented dimension types are fixed and limited:

- `time`
- `string`
- `number`
- `boolean`
- `switch`
- `geo`

Primary source:

- Cube types and formats: https://cube.dev/docs/product/data-modeling/reference/types-and-formats

Relevant lines:

- "A dimension can only have one type.": line 1143
- dimension type list: lines 704-710

There is no documented dimension type for:

- `array`
- `variant`
- `union of scalar and array`

Conclusion:

- A single Cube dimension cannot cleanly behave as:
  - `String` for one row,
  - `Array(String)` for another row
- Even if ClickHouse could synthesize such a mixed-shape result, it would not map cleanly onto Cube's dimension typing.

This directly affects the requirement:

- "If more than one match is found, return an array of the native value type. If only one match is found, return the native value type."

Assessment:

- This is not a good fit for Cube model semantics.
- The robust choices are:
  - always return scalar: first match or null
  - always return array
  - return a stringified representation such as JSON, but that sacrifices native typing
  - expose two separate members: one scalar, one array-like/stringified

---

## Finding 10: `location('Vehicle').label` is not a native Cube model syntax

No researched Cube documentation or installed source indicates support for:

- function-call member selection like `location('Vehicle').label`
- parameterized dimension names
- runtime member creation from a parameter

What Cube does support:

- static members
- compile-time dynamic generation of static members
- runtime filter parameters for SQL generation
- limited SQL-API expression support in special contexts

Conclusion:

- `location('Vehicle').label` would have to be invented by Synmetrix as a custom application syntax.
- If Synmetrix introduces it, the app would need to translate it into either:
  - a static pre-generated Cube member, or
  - an alternate SQL API / custom expression path

---

## Finding 11: `location.Vehicle.label` is also not a native Cube member syntax

This form is closer to an object-path mental model, but it still does not fit Cube's normal query-member grammar.

Reasons:

- REST member names are `cube.member`
- third segment is reserved for time granularity only
- the installed validator regex only allows two segments for ordinary members

Conclusion:

- `location.Vehicle.label` is not directly queryable as a Cube member name.
- Synmetrix could map it to a generated static member name such as `semantic_events.location_vehicle_label` or `semantic_events.location_vehicle_label_first`, but that mapping would be custom Synmetrix behavior, not Cube-native behavior.

---

## Finding 12: There are two realistic implementation strategies

### Option A: Generate discriminator-specific members at compile time

Generate one or more members per discovered `location_of` value and per sibling field.

Examples:

- `location_vehicle_label`
- `location_origin_label`
- `location_vehicle_country`
- `location_vehicle_latitude`
- `location_vehicle_longitude`

Possible ClickHouse SQL for scalar members:

```sql
arrayFirstOrNull(
  (value, kind) -> kind = 'Vehicle',
  {CUBE}.location.label,
  {CUBE}.location.location_of
)
```

Possible ClickHouse SQL for array members:

```sql
arrayFilter(
  (value, kind) -> kind = 'Vehicle',
  {CUBE}.location.label,
  {CUBE}.location.location_of
)
```

How to implement in Cube:

- generate these members in YAML via Jinja loops, or
- generate them in JS via `asyncModule()`

Pros:

- Works on normal REST / GraphQL query path.
- Keeps query members static and cacheable.
- Good fit because `location_of` has very low cardinality locally.

Cons:

- Member explosion if applied broadly.
- Requires regeneration when new discriminator values appear.
- Naming needs a clear convention.
- Array-valued members are still awkward in Cube.

### Option B: Build a flattened `location` cube/view using `ARRAY JOIN`

Since ClickHouse allows the whole nested structure name in `ARRAY JOIN`, create a separate cube or view that explodes `location` into one row per location entry.

Conceptual SQL:

```sql
SELECT
  base_columns...,
  loc.location_of,
  loc.label,
  loc.country,
  loc.latitude,
  loc.longitude
FROM cst.semantic_events
ARRAY JOIN location AS loc
```

Then query it as:

- dimension: `location_of`
- dimension: `label`
- filter: `location_of = 'Vehicle'`

Pros:

- Best semantic fit for the actual data structure.
- Avoids trying to fake object lookup inside a column.
- Preserves native typing for fields like latitude/longitude.
- Supports multiple matches naturally as multiple rows.

Cons:

- Changes row cardinality.
- May require separate exploration UX.
- Needs generator support for grouped/nested parents, not just plain arrays.

Assessment:

- This is the cleanest data-modeling option.
- It aligns with ClickHouse's own nested-data guidance around `ARRAY JOIN`.

---

## Finding 13: The scalar-vs-array requirement should be treated as unsupported in Cube models

The requested behavior:

- one match -> scalar native type
- multiple matches -> array native type

is not a good semantic or typing fit for Cube.

Why:

- Cube dimensions have one fixed type.
- REST/GraphQL consumers expect stable column types.
- ClickHouse lookup expressions like `arrayFirstOrNull` and `arrayFilter` naturally return different shapes.
- Combining them into one member would require a mixed/union type that Cube does not document for dimensions.

Recommended interpretation:

- Do not attempt a single member with shape-switching behavior.
- Pick one of these patterns instead:
  - `..._first` scalar member
  - `..._all` array-like member, likely stringified if Cube cannot carry arrays cleanly
  - flattened location cube where multiple matches become multiple rows

---

## Recommendation

### Best overall approach

Prefer a flattened `location` cube/view built with `ARRAY JOIN`, then filter by `location_of`.

Why this is the best fit:

- It matches the physical shape of the ClickHouse nested structure.
- It avoids inventing unsupported Cube member syntax.
- It preserves field typing cleanly.
- It handles multiple matches naturally as rows instead of mixed scalar/array return types.

### Best fallback if inline selector ergonomics matter more than purity

Generate discriminator-specific static members at compile time, for example:

- `location_vehicle_label_first`
- `location_vehicle_label_all`
- `location_origin_label_first`

This can be done from:

- Jinja-generated YAML, or
- JS `asyncModule()` models

This is a good fit specifically because local profiling shows `location_of` has only a handful of values.

### Not recommended

- relying heavily on `FILTER_PARAMS` for selector semantics
- inventing `location('Vehicle').label` without a rewrite layer
- inventing `location.Vehicle.label` as if Cube supported arbitrary multi-segment member paths
- trying to make one member alternate between scalar and array return types

---

## Concrete Answer To The Original Question

### Can any sort of parameters or dynamic field names be used in Cube models?

Yes, but only in limited ways:

- **Parameters**: yes, via `FILTER_PARAMS`, but only for SQL generation and top-level `WHERE` predicate pushdown.
- **Dynamic field generation**: yes, at compile time via Jinja or `asyncModule()`.
- **Dynamic field names at query time**: effectively no on the standard Cube REST / GraphQL path.

### Is `location('Vehicle').label` possible as a native Cube selector?

No, not as native Cube syntax.

### Is `location.Vehicle.label` possible as a native Cube selector?

No, not as native Cube syntax on the normal REST path.

### Can the `location_of` child be treated as a lookup discriminator in SQL?

Yes, ClickHouse can do that with array functions or `ARRAY JOIN`.

### Can one Cube member return scalar for one row and array for another?

Not cleanly. Treat this as unsupported for practical Cube modeling.

---

## Source List

### Local Synmetrix sources

- [services/cubejs/package.json](/Users/stefanbaxter/Development/synmetrix/services/cubejs/package.json)
- [services/cubejs/src/utils/repositoryFactory.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/repositoryFactory.js)
- [services/cubejs/src/utils/mapSchemaToFile.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/src/utils/mapSchemaToFile.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/query.js)
- [services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/api-gateway/dist/src/gateway.js)
- [services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js](/Users/stefanbaxter/Development/synmetrix/services/cubejs/node_modules/@cubejs-backend/schema-compiler/dist/src/compiler/DataSchemaCompiler.js)
- [test-output/semantic_events_profile.json](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events_profile.json)
- [test-output/semantic_events.yml](/Users/stefanbaxter/Development/synmetrix/test-output/semantic_events.yml)

### Primary external sources

- ClickHouse Nested docs:
  - https://clickhouse.com/docs/sql-reference/data-types/nested-data-structures/nested
- ClickHouse tuple functions:
  - https://clickhouse.com/docs/sql-reference/functions/tuple-functions
- ClickHouse array functions:
  - https://clickhouse.com/docs/sql-reference/functions/array-functions
- Cube REST API query format:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/rest-api/query-format
- Cube querying docs:
  - https://cube.dev/docs/product/apis-integrations/core-data-apis/queries
- Cube context variables:
  - https://cube.dev/docs/product/data-modeling/reference/context-variables
- Cube dynamic JavaScript models:
  - https://cube.dev/docs/product/data-modeling/dynamic/javascript
- Cube dynamic YAML/Jinja models:
  - https://cube.dev/docs/product/data-modeling/dynamic/jinja
- Cube types and formats:
  - https://cube.dev/docs/product/data-modeling/reference/types-and-formats

---

## Final Assessment

The desired selector behavior is conceptually valid for the data, but not as a native Cube member syntax. ClickHouse can do the lookup; Cube can only expose it through static members or a flattened cube. For Synmetrix, the technically sound direction is either:

1. a flattened `location` cube with `ARRAY JOIN`, or
2. compile-time generated discriminator-specific members.

Anything closer to `location('Vehicle').label` or `location.Vehicle.label` would be custom Synmetrix syntax layered on top of those static implementations.
