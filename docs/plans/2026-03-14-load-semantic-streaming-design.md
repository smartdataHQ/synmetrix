# Semantic `/load` Streaming Design

**Date:** 2026-03-14  
**Status:** Proposed  
**Related:** `009-export-formats.md`, `009-load-endpoint-streaming-passthrough.md`

## Goal

Design a `/load` implementation that:

1. Supports normal Cube query objects and request semantics.
2. Preserves Synmetrix and Cube security, datasource, branch, version, and query parameter handling.
3. Uses true streaming when the underlying execution stack supports it, especially for ClickHouse CSV and Arrow.

## Requirements

### Functional

- The external request contract remains the Cube `/load` contract:
  - semantic query object
  - same auth headers
  - same datasource / branch / version scoping
  - same cache and query parameters
- `format=json` must keep current behavior.
- `format=csv|arrow` must use streaming when available.
- `format=csv|arrow` must preserve semantic query behavior:
  - query normalization
  - `queryRewrite`
  - row-level security
  - member expressions
  - pre-aggregation selection/loading
  - alias/member mapping

### Non-Functional

- Do not buffer full result sets in CubeJS for streaming-capable paths.
- Preserve backpressure and client abort handling.
- Do not turn `/load` into a raw-SQL endpoint.

## Current Problem

Today Synmetrix handles `/load?format=csv|arrow` by intercepting the final JSON response after CubeJS has already executed and materialized the result set.

That means:

- CubeJS `/load` executes via the normal non-streaming `executeQuery()` path.
- ClickHouse `driver.query()` uses `format: JSON` and `resultSet.json()`.
- Synmetrix only transforms the already-buffered `cubeResponse.data` into CSV or Arrow.

Result:

- CSV is only streamed from app memory to the client, not from the database through Cube.
- Arrow is fully buffered and serialized in process.
- ClickHouse native CSV and Arrow streaming are not used on `/load`.

## Decision

Do **not** make `/load` streaming a post-processing optimization on top of the existing buffered `/load` response.

Do **not** use compile-to-SQL then call `/run-sql` as the primary semantic export engine.

Instead:

- Keep `/load` as the public semantic query interface.
- Add a dedicated **semantic export execution path** for `format=csv|arrow`.
- Use Cube's semantic normalization and execution pipeline first.
- Use a streaming backend under that semantic pipeline.
- Add native database passthrough only as an optimization under the semantic execution layer, not as the semantic execution layer itself.

## Why This Is Better

### Why not keep the current intercept approach

Because interception happens too late. By the time Synmetrix sees the response:

- query execution is done
- results are materialized
- memory has already been spent

No downstream response transform can recover true streaming from that.

### Why not use compile -> `run-sql` as the main solution

Compiling semantic queries to SQL preserves part of the semantic layer, but it is not the same as executing through Cube's normal `/load` path.

The main gap is execution semantics:

- `/load` goes through the orchestrator and pre-aggregation loading path
- `/run-sql` goes directly to `driverFactory(...).query()` or driver-native APIs

That means compile -> `run-sql` is useful as a fallback or optimization path, but not as the canonical implementation for semantic exports.

## Proposed Architecture

### External API

Keep the existing endpoint:

- `POST /api/v1/load`
- `GET /api/v1/load`

Supported formats:

- `json`
- `csv`
- `arrow`
- `jsonstat`

Behavior split:

- `json` -> current Cube `/load` path
- `jsonstat` -> current buffered transform path for now
- `csv|arrow` -> new semantic export path

### Internal Execution Modes

#### Mode 1: Standard semantic load

Used for:

- `format=json`
- existing dashboard / API consumers

Implementation:

- current `ApiGateway.load()` path

#### Mode 2: Semantic export load

Used for:

- `format=csv`
- `format=arrow`

Implementation:

- same semantic query parsing and security handling as `/load`
- different execution backend chosen before normal buffered response generation

## Semantic Export Pipeline

For `format=csv|arrow`, the pipeline should be:

1. Validate format and parse query.
2. Authenticate and build `securityContext`.
3. Run the same Cube normalization pipeline:
   - query type detection
   - row-level security
   - `queryRewrite`
   - member expression parsing/evaluation
   - datasource resolution
4. Build semantic execution metadata:
   - normalized query
   - annotation
   - SQL query object
   - alias-to-member mapping
   - pre-aggregation metadata
5. Choose best available stream source.
6. Stream encoded output to the client.

## Stream Source Hierarchy

The semantic export path should choose among these backends.

### Backend A: Semantic row stream

This should be the canonical streaming abstraction.

Source:

- Cube semantic streaming path via internal `stream()` / `sqlApiLoad(..., streaming: true)` behavior

Properties:

- preserves semantic aliases
- preserves Cube normalization/security behavior
- preserves pre-aggregation loading
- streams row objects rather than raw bytes

Usage:

- always acceptable for CSV
- acceptable for Arrow via incremental Arrow IPC writer

### Backend B: Native database format passthrough

This is an optimization, not the main abstraction.

Use only when all of the following are true:

- the semantic execution plan has already been resolved
- column names and order match semantic output exactly
- pre-aggregation selection/loading has already been honored
- the native stream can be returned without breaking semantic behavior

Examples:

- ClickHouse CSV native stream
- ClickHouse ArrowStream native stream

This backend can eventually deliver the lowest memory and CPU cost, but it must sit under semantic planning, not replace it.

### Backend C: Buffered fallback

Use only when no stream path exists.

Examples:

- drivers without stream support
- formats whose encoder is not yet incremental
- complex query types unsupported by the export stream path

This fallback should reuse the current buffered transform behavior.

## Capability Model

The implementation should make capability decisions explicitly rather than hardcoding ClickHouse checks in route logic.

Suggested capability dimensions:

- `semanticRowStream`
- `nativeCsvPassthrough`
- `nativeArrowPassthrough`
- `incrementalArrowEncode`

Suggested output of a capability resolver:

```js
{
  semanticRowStream: true,
  nativeCsvPassthrough: true,
  nativeArrowPassthrough: true,
  incrementalArrowEncode: true
}
```

Initial expectation:

- ClickHouse:
  - `semanticRowStream: true`
  - `nativeCsvPassthrough: true`
  - `nativeArrowPassthrough: true`
- most other drivers:
  - `semanticRowStream: false` or unknown
  - native passthrough: false

## Security and Parameter Invariants

The semantic export path must preserve all of the following:

- `Authorization`
- `x-hasura-datasource-id`
- `x-hasura-branch-id`
- `x-hasura-branch-version-id`
- query `timezone`
- query filters, order, limit, offset, segments, member expressions
- team/member access control
- query rewrite rules

This means the route must not invent a separate security model for exports.

## Pre-Aggregations and Cache Semantics

This is the main reason not to make compile -> `run-sql` the primary design.

The semantic export path must preserve:

- pre-aggregation resolution
- loading of required rollups
- staging / queue / wait behavior
- transformed query usage where applicable

The ideal design is:

- semantic export executes through the same orchestrator-backed semantic path as `/load`
- export backends only change how rows are emitted, not how the semantic plan is executed

## Continue Wait and Retry Behavior

The export path must explicitly define how it behaves when the semantic query cannot stream immediately because:

- the query is still queued
- pre-aggregations are building
- Cube would normally return `Continue wait`

Recommended behavior:

- Preserve Cube's `Continue wait` JSON contract until the stream is actually ready.
- Only switch to file streaming once execution has started.

Why:

- this keeps semantic behavior aligned with Cube
- it avoids inventing a second queue model for exports
- it keeps pre-aggregation build behavior consistent

This does mean clients exporting CSV/Arrow need retry handling before the file stream starts. That is acceptable and matches existing Cube behavior more closely than bypassing the execution path.

## Query Type Policy

The first version should explicitly support:

- regular single-result semantic queries

The first version should reject or defer:

- blending queries
- multi-result queries
- subscribe semantics

Reason:

- current Synmetrix export logic already effectively assumes a single result
- streaming multi-result CSV/Arrow needs a clear envelope format
- forcing explicit handling is safer than silently exporting only `results[0]`

## Route Design

### Keep `routes/index.js` as the dispatcher

Recommended high-level behavior:

```text
/api/v1/load
  -> validate format
  -> if json: next() to normal Cube load
  -> if jsonstat: current buffered transform path
  -> if csv|arrow:
       semantic export executor
         -> if stream available: stream response
         -> else: buffered fallback
```

### New internal module

Add a new internal module rather than expanding `index.js` further.

Suggested names:

- `services/cubejs/src/routes/loadExport.js`
- `services/cubejs/src/utils/semanticExport.js`

The route file should remain a thin dispatcher.

## Recommended Implementation Strategy

### Phase 1

Build semantic CSV streaming using Cube semantic row streams.

This is the safest first target because:

- CSV row encoding is straightforward
- row stream preserves semantic aliases naturally
- it validates the semantic streaming architecture before adding native passthrough

### Phase 2

Build semantic Arrow streaming using incremental Arrow IPC output.

Important detail:

- do not use the current `serializeRowsToArrow(rows)` path for streaming
- it is intentionally full-buffer and column-materializing

Implementation note:

- use an incremental RecordBatch / IPC writer if the library supports it
- otherwise emit Arrow in bounded record batches while preserving a valid Arrow stream

### Phase 3

Add capability-aware ClickHouse native passthrough for semantic exports.

Do this only after:

- semantic stream path is working
- invariants around aliases and pre-aggregations are proven
- fallback path exists

### Phase 4

Optionally factor `/run-sql` and semantic export backends to share:

- abort handling
- backpressure helpers
- CSV chunk writing
- ClickHouse native format helpers

## Detailed Plan

### Workstream 1: Extract shared stream helpers

Create shared utilities for:

- abort-controller lifecycle
- response close / finish tracking
- binary chunk writes
- text chunk writes
- consistent CSV headers
- consistent Arrow headers

Target files:

- new `services/cubejs/src/utils/streamResponse.js`
- refactor `runSql.js` to use it

### Workstream 2: Build semantic export planner

Create an internal planner that:

- takes the raw Cube query + request context
- runs Cube normalization / query rewrite / security flow
- returns:
  - normalized query
  - query type
  - annotation
  - sql query object
  - alias mapping
  - execution capability metadata

Target files:

- new `services/cubejs/src/utils/semanticExportPlan.js`

### Workstream 3: Build semantic row stream executor

Create an executor that:

- obtains a semantic stream from Cube internals
- preserves pre-aggregation/orchestrator behavior
- exposes:
  - stream
  - metadata
  - cleanup / release

Target files:

- new `services/cubejs/src/utils/semanticRowStream.js`

### Workstream 4: Build CSV export backend

Implement:

- `streamSemanticCsv(plan, req, res)`

Behavior:

- semantic row stream -> CSV encoder -> HTTP response
- preserve backpressure
- preserve abort behavior
- preserve `Continue wait` before stream start

Target files:

- new `services/cubejs/src/utils/semanticCsvExport.js`

### Workstream 5: Build Arrow export backend

Implement:

- `streamSemanticArrow(plan, req, res)`

Behavior:

- semantic row stream -> incremental Arrow IPC writer -> HTTP response
- bounded batching only
- no full row array materialization

Target files:

- new `services/cubejs/src/utils/semanticArrowExport.js`

### Workstream 6: Add route dispatcher

Update `/load` route behavior:

- `json` -> current behavior
- `jsonstat` -> current buffered path
- `csv|arrow` -> semantic export dispatcher

Target files:

- `services/cubejs/src/routes/index.js`

### Workstream 7: Add native passthrough optimization

After semantic row streaming works:

- add capability resolver
- implement ClickHouse native CSV passthrough when semantic fidelity is guaranteed
- implement ClickHouse native Arrow passthrough when semantic fidelity is guaranteed

This should be a second pass, not part of the initial architecture landing.

Target files:

- new `services/cubejs/src/utils/exportCapabilities.js`
- reuse helper logic from `runSql.js`

## File-Level Plan

### Files to modify

- `services/cubejs/src/routes/index.js`
- `services/cubejs/src/routes/runSql.js`

### Files to add

- `services/cubejs/src/utils/streamResponse.js`
- `services/cubejs/src/utils/semanticExportPlan.js`
- `services/cubejs/src/utils/semanticRowStream.js`
- `services/cubejs/src/utils/semanticCsvExport.js`
- `services/cubejs/src/utils/semanticArrowExport.js`
- `services/cubejs/src/utils/exportCapabilities.js`

## Testing Plan

### Unit tests

- format dispatch behavior
- capability selection
- CSV row-stream encoding
- Arrow batch-stream encoding
- abort handling
- backpressure handling

### Integration tests

- `/load?format=csv` on ClickHouse returns streaming CSV
- `/load?format=arrow` on ClickHouse returns streaming Arrow
- `/load?format=csv` preserves semantic aliases and filters
- `/load?format=csv` honors branch/version/datasource headers
- `/load?format=csv` returns `Continue wait` when semantic execution is not ready
- `/load?format=csv` uses buffered fallback on non-streaming drivers

### Regression tests

- `format=json` unchanged
- `format=jsonstat` unchanged
- `/run-sql` unchanged

## Risks

### Risk 1: Cube internal streaming APIs are not designed for direct Express reuse

Mitigation:

- wrap them behind a Synmetrix-local executor abstraction
- do not couple route logic directly to internal package shapes

### Risk 2: Arrow incremental encoding may be harder than CSV

Mitigation:

- land CSV semantic streaming first
- keep current Arrow buffered fallback until incremental Arrow writer is ready

### Risk 3: Native passthrough may drift from semantic aliases

Mitigation:

- native passthrough is phase 2 optimization only
- row-stream path remains canonical and always correct

## Recommendation Summary

The right architecture is:

- preserve `/load` as the external semantic interface
- add a separate internal semantic export execution path for `csv|arrow`
- use Cube semantic streaming as the primary execution model
- use native ClickHouse passthrough only as an optimization under that model

This satisfies all three user constraints:

- supports Cube query objects
- preserves Synmetrix and Cube security/parameter behavior
- supports full streaming when the stack can actually provide it
