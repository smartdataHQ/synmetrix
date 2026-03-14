# JSON-Stat Encoder Optimization Research

Date: 2026-03-12

## Scope

This note documents:

- JSON-stat format constraints that matter for encoding performance.
- Analysis of `services/cubejs/src/utils/jsonstatBuilder.js`.
- Caller-side constraints from `services/cubejs/src/routes/index.js` and `services/cubejs/src/routes/runSql.js`.
- All identified correctness risks, performance options, payload-size options, and follow-up suggestions.

The goal is not only to optimize the current encoder, but to identify which changes are actually worth making in this codebase.

## Sources

Primary sources used for the format research:

- JSON-stat full format specification: https://json-stat.org/full/
- JSON-stat JavaScript toolkit sample page: https://json-stat.org/tools/js

Local code reviewed:

- `services/cubejs/src/utils/jsonstatBuilder.js`
- `services/cubejs/test/jsonstatBuilder.test.js`
- `services/cubejs/src/routes/index.js`
- `services/cubejs/src/routes/runSql.js`

## JSON-stat Format Constraints That Matter

### 1. Dense array output is not mandatory

JSON-stat allows `value` to be encoded either as:

- a dense array, where position is implied by `id` and `size`
- a sparse object, where populated positions are keyed explicitly

This matters because the current encoder always materializes a dense `value` array filled with `null`, even when the cube is sparse.

### 2. Category metadata has representation choices

For `dimension.*.category.index`, JSON-stat allows:

- an object mapping category id to position
- an array whose order implies the positions

This matters because the current encoder always emits object form and also duplicates every category id into `category.label`.

### 3. Dimension order defines value order

The current stride math assumes row-major flattening with the rightmost dimension varying fastest. That matches the JSON-stat model and is the correct basis for efficient encoding.

### 4. Metric dimensions are a modeling convention, not a required name

Representing measures as a synthetic metric dimension is valid, but the dimension id does not have to be literally `"metric"`. The current implementation hard-codes that id and can collide with real data.

## Current Implementation Summary

The encoder already does several useful things:

- disambiguates duplicate column names
- scans rows once to classify columns and collect categories
- computes flat offsets with precomputed strides
- merges duplicate tuples before writing the final array
- emits dataset-level `role.time` and `role.metric`

At a high level, the implementation is already using the right dense-encoding strategy. The main remaining opportunities are:

- reducing memory amplification
- reducing payload size
- removing unnecessary work on explicit-metadata paths
- fixing correctness issues before making deeper optimizations

## Caller Constraints

### `/v1/load` path

`services/cubejs/src/routes/index.js` supplies:

- `rows` from Cube response `data`
- `columns` from `Object.keys(data[0])`
- `measures` from `annotation.measures`
- `timeDimensions` from `annotation.timeDimensions`

Implication:

- this is usually the stronger path because classification hints are available
- heuristic classification is mostly fallback behavior here
- empty-result schema is lost because columns are inferred from the first row only

### `/v1/run-sql` path

`services/cubejs/src/routes/runSql.js` supplies:

- `rows` from `driver.query(sql)`
- `columns` from `Object.keys(rows[0])`
- `measures` and `timeDimensions` only if the client provides them

Implication:

- correctness depends more heavily on heuristics when clients omit hints
- empty-result schema is also lost here

### Architectural limit

Both JSON-stat paths fully materialize rows before encoding. That means:

- the encoder cannot be constant-memory today
- builder-level micro-optimizations will help, but they do not change the fundamental memory profile
- truly large-result optimization requires caller or driver contract changes

## Findings

## Correctness Risks

### 1. Dimension key collisions from string coercion

The encoder uses `String(v ?? "")` when building category maps and when computing tuple offsets.

Impacts:

- `null` and `""` collapse into the same category
- `1` and `"1"` collapse into the same category
- `false` and `"false"` collapse into the same category

This can silently corrupt both:

- category cardinality
- merged observation placement

This is the most important issue to fix before deeper optimization.

### 2. Synthetic `"metric"` dimension can collide with a real dimension

When measures exist, the encoder always appends a synthetic dimension with id `"metric"`.

If the source data already has a real dimension named `"metric"`:

- `id` can contain duplicate entries
- `dimension.metric` can be overwritten
- the output dataset becomes ambiguous or invalid

### 3. Duplicate tuple handling is opinionated and potentially unsafe

If two rows map to the same dimension tuple, the encoder:

- sums numeric measures
- keeps the last non-numeric value

This may be acceptable for a deliberate rollup mode, but it is not a neutral encoding behavior. It changes the data semantics.

### 4. Duplicate-name hint mapping is incomplete

For repeated columns, explicit hints such as `options.measures` and `options.timeDimensions` map only to the first deduped column name.

In practice, this is not important for current callers because duplicate column names do not realistically survive `Object.keys(row)`, but the logic itself is incomplete.

### 5. Empty results lose schema

If there are no rows, both callers pass no usable column schema into the builder. The builder then returns a 400 error for an otherwise valid empty result shape.

This is mostly a route-level issue, not an encoder issue.

## Test Coverage Gaps

Current tests verify shape and basic invariants, but they do not adequately cover:

- exact row-major `value` placement
- sparse combinations remaining `null` in the correct slots
- duplicate tuple behavior
- type-collision cases such as `null` vs `""`
- synthetic metric name collision
- empty-result metadata consistency

The current suite passes, but it would not catch several real regressions.

## Optimization Options

## Highest-Impact Options

### 1. Add sparse `value` object output

Description:

- Add a mode that emits `value` as an object keyed by flat offset, instead of allocating a dense null-filled array.

Why it matters:

- avoids `new Array(totalObs).fill(null)` for sparse cubes
- avoids serializing huge runs of `null`
- fits naturally with the current `mergedMap` intermediate representation

Best use:

- large multidimensional cubes with many missing combinations
- any dataset where `populatedCells << product(size)`

Tradeoffs:

- some consumers may expect dense arrays
- compatibility should be validated with downstream tools before making it the default

Recommendation:

- implement as an optional mode first
- auto-enable when density falls below a chosen threshold

### 2. Add a cardinality guard and automatic mode selection

Description:

- before allocating dense output, estimate `product(size) * effectiveMeasureCount`
- if it exceeds a threshold, either:
  - switch to sparse-object mode
  - reject the request
  - warn and require explicit opt-in

Why it matters:

- prevents pathological memory usage
- protects `run-sql` especially, since it currently has no JSON-stat safety guard

Recommendation:

- combine this with sparse mode
- track both total cell count and density

### 3. Split explicit-metadata and heuristic paths

Description:

- when `measures` and `timeDimensions` are explicitly known, skip heuristic-only work

Specific savings:

- do not build category maps for measure columns
- do not do numeric inference for columns already known to be dimensions or measures
- reduce unnecessary `Set` and `Map` churn on the common `/v1/load` path

Why it matters:

- `/v1/load` usually already has annotation metadata
- current code builds `catMaps` and `catOrders` for every column up front, even those later discarded as measures

Recommendation:

- refactor into:
  - fast path: explicit metadata
  - fallback path: heuristic inference

### 4. Remove one intermediate structure on dense mode

Description:

- today dense output is built via:
  - `mergedMap`
  - then `value[]`

For dense mode, it may be cheaper to:

- allocate `value[]` once
- write directly by offset
- keep a separate bitset or set only if duplicate detection is needed

Why it matters:

- reduces peak memory
- reduces one full pass over populated tuples

Tradeoffs:

- more complicated duplicate-handling logic
- sparse-object mode still benefits from `mergedMap`

Recommendation:

- do this only after deciding duplicate semantics
- likely worthwhile for dense mode, not mandatory for sparse mode

## Payload-Size Options

### 5. Support compact category encoding

Description:

- use `category.index` as an array when category ids and order are enough
- optionally omit `category.label` when it would just duplicate ids

Why it matters:

- current output stores every category id twice
- category metadata can dominate payload for high-cardinality dimensions

Tradeoffs:

- some consumers are more comfortable with object-form `index`
- labels may still be required for friendly display in some clients

Recommendation:

- add an encoder option such as:
  - `categoryIndex: "object" | "array"`
  - `includeCategoryLabels: boolean`

### 6. Add a single-measure fast path

Description:

- when there is exactly one measure, avoid creating a synthetic per-tuple measure array during merge

Why it matters:

- many queries are single-measure
- reduces small-array allocation churn

Impact:

- moderate, not transformative

Recommendation:

- good cleanup optimization after correctness fixes

## Lower-Value or Context-Dependent Options

### 7. Remove or isolate duplicate-column remapping

Description:

- duplicate column support is largely dead code under the current caller architecture

Why it matters:

- it adds complexity and object remapping work
- current callers derive columns from JS object keys, which do not preserve true duplicate names

Recommendation:

- either remove it
- or keep it behind a dedicated lower-level API that receives explicit column metadata from a driver

This is more about simplifying maintenance than improving runtime significantly.

### 8. Micro-optimize object creation

Examples:

- replace some `Object.keys(role).length > 0` checks with boolean flags
- avoid `activeCols = activeIndices.map(...)`
- reduce temporary arrays where possible

Impact:

- minor

Recommendation:

- not worth prioritizing until higher-impact changes are settled

## Suggestions By Priority

## Priority 0: Fix correctness first

1. Replace raw string coercion for dimension keys with a stable typed encoding.
2. Avoid hard-coding `"metric"` when it collides with real dimensions.
3. Make duplicate tuple handling explicit:
   - error
   - aggregate with defined reducer
   - last-write-wins
4. Add tests for all three issues above.

## Priority 1: Add safe scalability controls

1. Add sparse-object `value` output.
2. Add a cardinality guard for dense mode.
3. Add route-level protection for `run-sql` JSON-stat responses similar to the existing JSON guard.

## Priority 2: Optimize the common path

1. Split explicit-metadata and heuristic paths.
2. Skip category collection for known measure columns.
3. Add a single-measure fast path.

## Priority 3: Reduce payload size

1. Support array-form `category.index`.
2. Allow omission of redundant category labels.
3. Consider exposing a compact JSON-stat mode separately from the default compatibility mode.

## Route-Level Suggestions

### 1. Preserve schema for empty results

The current builder can produce a valid empty dataset if it is given column metadata, but both callers lose that metadata on empty results.

Suggestions:

- `/v1/load`: derive columns from Cube annotation instead of only from the first row
- `/v1/run-sql`: if available, use driver metadata or a schema inspection path for empty results

### 2. Decide whether JSON-stat should be dense or adaptive by default

Reasonable default policy:

- dense output for small or near-dense datasets
- sparse-object output for large sparse datasets

This should be a product decision because compatibility expectations vary by consumer.

### 3. Consider a streaming-oriented lower-level API for raw SQL exports

The current route contracts materialize all rows in memory before encoding. If very large JSON-stat exports become important, the bigger change is not inside the builder. It is in the route and driver layer:

- iterate rows as a stream
- collect only dimension/category state that is actually needed
- write output incrementally where format permits

This is much harder than CSV streaming, but it is where the real architectural headroom sits.

## Recommended Next Implementation Slice

The most defensible next slice is:

1. Fix typed category identity and metric-name collision.
2. Add tests for row-major placement, sparse combinations, duplicate tuples, and key-collision cases.
3. Add sparse `value` object mode behind an option.
4. Add a dense-mode cell-count guard.
5. Refactor the builder into explicit-metadata and heuristic paths.

This sequence improves correctness first, then adds the highest-value scalability feature, then trims avoidable work.

## Proposed Test Additions

- `null` and `""` remain distinct dimension categories
- `1` and `"1"` remain distinct dimension categories
- a real dimension named `metric` does not collide with the synthetic metric dimension
- row-major flattening produces the expected offsets
- missing combinations remain `null` in dense mode
- sparse mode emits only populated offsets
- duplicate tuples follow the chosen policy exactly
- empty-result datasets preserve `id`, `size`, `dimension`, and `role` consistently

## Bottom Line

The current encoder already has the correct dense flattening model. The biggest remaining opportunities are not low-level arithmetic tricks. They are:

- fixing correctness traps
- avoiding dense null-filled arrays for sparse cubes
- avoiding work that is unnecessary when metadata is already known
- reducing payload duplication in category metadata

If only one optimization is implemented, it should be sparse `value` object support plus a cardinality guard. That is the clearest performance win with the best leverage against large-result failure modes.
