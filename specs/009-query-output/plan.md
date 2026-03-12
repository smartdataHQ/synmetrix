# Implementation Plan: Improved Query Output

**Branch**: `009-query-output` | **Date**: 2026-03-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-query-output/spec.md`

## Summary

Add CSV and JSON-Stat 2.0 output formats to the raw SQL query endpoint (`/api/v1/run-sql`) via a `format` parameter. For ClickHouse, return CSV natively using `FORMAT CSVWithNames` (MVP uses `resultSet.text()`; upgraded to true streaming via `resultSet.stream()` in P3/US6). For other databases, serialize rows to CSV server-side. Build JSON-Stat output using an optimized fork of `jsonstat-toolkit` with 6 performance fixes, 3 new methods (`fromRows`, `toCSV`, `unflattenIterator`), and streaming support. JSON-Stat requests accept optional `measures` and `timeDimensions` hints for exact dimension/measure classification. Add a format selector to the Explore page that uses the gen_sql → run-sql chain to export semantic queries in any format (JSON, CSV, JSON-Stat). Remove row limits for CSV and JSON-Stat exports; JSON retains existing limits.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22+
**Primary Dependencies**: Express 4.18.2 (CubeJS routes), `@cubejs-backend/clickhouse-driver` (wraps `@clickhouse/client` ^1.12.0), `smartdataHQ/toolkit` (jsonstat-toolkit fork, zero deps), React 18 + Vite + Ant Design 5 (client-v2)
**Storage**: N/A — no database schema changes. Query results are transient.
**Testing**: StepCI (integration), custom assert-based (toolkit), Vitest (client-v2), manual benchmark scripts (performance)
**Target Platform**: Linux containers (Docker), macOS dev
**Project Type**: Web service (CubeJS routes) + library (jsonstat-toolkit fork) + frontend (client-v2 format selector + limit removal)
**Performance Goals**: CSV response begins within 1s for ClickHouse (MVP via `resultSet.text()`, upgraded to true streaming in US6); Transform() < 500ms on 100K observations; JSON-Stat payload 50%+ smaller than JSON for 3+ dimension queries; constant memory for 1M row CSV exports (US6 streaming path)
**Constraints**: Zero regression in existing JSON output; all existing toolkit tests pass; auth chain unchanged; no row limits for CSV/JSON-Stat exports (JSON retains existing limits)
**Scale/Scope**: Supports 1M+ row exports via streaming (US6); 100K+ observation JSON-Stat datasets; no artificial row caps

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| **Service Isolation** | PASS | Format handling stays in CubeJS routes (where run-sql already lives). Toolkit is an external library. No cross-service coupling added. |
| **Multi-Tenancy First** | PASS | Auth chain (JWT → defineUserScope → driverFactory) is unchanged. Format param applied after all auth gates. Query rewrite rules still block SQL API when active. |
| **TDD** | PASS | Unit tests for CSV escaping, JSON-Stat construction. Integration tests via StepCI. Benchmark tests for toolkit performance. Toolkit's existing 80 tests preserved. |
| **Security by Default** | PASS | No new auth surface. Format is output-only — doesn't expand data access. SQL API remains blocked when query rewrite rules exist. |
| **Simplicity / YAGNI** | PASS | Path A (format param on existing route) is the simplest approach. No new routes, no new services, no new middleware. Toolkit optimizations target 6 specific measured bottlenecks. |

**Post-Phase 1 Re-check**: All gates still pass. The design adds a format parameter to an existing route and optimizes a library — no new services, no new abstractions, no new auth surfaces.

## Project Structure

### Documentation (this feature)

```text
specs/009-query-output/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   ├── run-sql-format.md        # API contract for format parameter
│   └── jsonstat-toolkit-extensions.md  # Toolkit new methods contract
└── tasks.md             # Phase 2 output (NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
services/cubejs/
├── src/
│   ├── routes/
│   │   └── runSql.js            # Add format parameter handling + CSV/JSON-Stat response
│   └── utils/
│       ├── csvSerializer.js     # RFC 4180 CSV serialization (non-ClickHouse fallback)
│       └── jsonstatBuilder.js   # Query results → JSON-Stat 2.0 conversion
└── test/
    ├── csvSerializer.test.js
    └── jsonstatBuilder.test.js

# Actions service (gen_sql extension)
services/actions/src/rpc/
└── genSql.js                    # Extend: add limit override + column metadata in response

# Hasura (gen_sql action contract)
services/hasura/metadata/
├── actions.graphql              # Add limit param + column_metadata output to gen_sql
└── actions.yaml                 # Update gen_sql action definition

# External: smartdataHQ/toolkit (separate repo)
toolkit/
├── src/                         # Optimized source (6 performance fixes + 3 new methods)
├── test/                        # Existing ~80 tests + new tests for extensions
└── benchmarks/                  # Performance benchmark scripts (100K, 1M datasets)

# Frontend: client-v2 (../client-v2)
src/
├── components/
│   ├── ExploreDataSection/
│   │   └── index.tsx            # Replace react-csv export with format selector + server-side export
│   └── ExploreSettingsForm/
│       └── index.tsx            # Bypass MAX_ROWS_LIMIT for CSV/JSON-Stat exports
├── graphql/gql/
│   └── explorations.gql         # Update GenSQL mutation: add limit input + column_metadata output
└── hooks/
    └── useFormatExport.ts       # New hook: gen_sql(limit:0) → extract aliases → run-sql with format → download
```

**Structure Decision**: Changes span 4 codebases — CubeJS service (format handling), Actions service (gen_sql extension), jsonstat-toolkit fork (library optimizations), and client-v2 (format selector + export). Hasura metadata is also modified (gen_sql action contract). This matches the existing monorepo + external dependency pattern. No new services or projects introduced.

**ClickHouse Driver Note**: The `@cubejs-backend/clickhouse-driver` v1.6.21 hardcodes `format: 'JSON'` in `queryResponse()` (line 166) and calls `resultSet.json()` (line 180). Neither `query()` nor `queryResponse()` support non-JSON formats. For native CSV, the implementation accesses `driver.client` (the internal `@clickhouse/client` instance created at line 99) and calls `client.query({ query, format: 'CSVWithNames' })` directly. ClickHouse NULL values render as `\N` in CSV and must be post-processed to empty strings for RFC 4180 compliance.

**Deployment Coordination**: The `format` parameter on `POST /api/v1/run-sql` is a contract addition (new request field, new response types). CubeJS MUST deploy before or simultaneously with client-v2 for the frontend format selector (US5) to function. This is a forward-compatible change — the new field is optional with `"json"` as default, so deploying CubeJS first does not break existing clients.

**Frontend Validation**: After client-v2 changes, `yarn codegen` and `yarn lint` MUST pass to satisfy constitution principle III (cross-project contract validation). The GenSQL mutation already exists in `explorations.gql` and is not modified, so no `.gql` file changes are needed.

## Complexity Tracking

No constitution violations to justify. The implementation follows the simplest path (format param on existing route) with targeted library optimizations.
