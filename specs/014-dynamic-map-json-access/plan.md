# Implementation Plan: Dynamic Map/JSON Field Access

**Branch**: `014-dynamic-map-json-access` | **Date**: 2026-07-07 | **Spec**: [spec.md](./spec.md)
**Prerequisite**: 013-mature-default-models fully implemented (pre-processor, templates, reconciliation, worker).

## Summary

Three additive pieces over 013's machinery. (1) **R3 rewrite rule** in the existing pre-processor: `Cube.<map>.<key>` member references are rewritten onto template-declared FILTER_PARAMS **parameter slots** with the key filter injected — dynamic keys, zero implicit members, slot-exhaustion rejected deterministically. (2) **Dynamic property discovery**: a new checkAuth-gated CubeJS route probes the team's partition slice (optionally filter-scoped, e.g. one event) for map keys (`mapKeys` + per-key stats) and JSON paths (`JSONAllPaths` + `dynamicType` distribution), returning a cube-meta-shaped directory with ready-to-use REST and SQL query forms, cached in-memory with a short TTL. (3) **Explicit generation mode**: `field_policy: explicit` on templates flips `buildCubesFromTemplate` from probe-adds-fields to probe-prunes-registry — enabling event-scoped, registry-governed template cubes that ride the 013 rollout unchanged. All decisions and rejected alternatives are recorded in the 013 research addendum (member expressions on REST rejected for security; lazy materialization rejected by product owner; visibility-hiding kept as a non-primary tool).

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 22.x (CubeJS service only — Actions untouched)
**Primary Dependencies**: Cube.js v1.6.37 (existing), `yaml` (existing). **No new npm dependencies.**
**Storage**: No new tables. Registry + slots live inside template files (013 storage). Discovery cache is in-memory (TTL).
**Testing**: node:test unit suites (existing patterns), StepCI workflow in `tests/workflows/default-models/dynamic-access.yml`
**Performance Goals**: warm discovery ≤ 50ms p95, cold ≤ 2s p95 (SC-002); rewrite adds no measurable latency to the existing pre-processor budget (013 measured 3.7ms whole-request p95)
**Constraints**: no implicit member creation anywhere (SC-003); REST member expressions stay disabled (FR-011); whole-map selection never generated (driver hydration corruption — research)
**Verified platform facts this plan rests on** (installed-code audit, 2026-07-07): member `sql:` is verbatim passthrough; FILTER_PARAMS resolves per-member independently, absent → `1 = 1`; `public:false` members remain queryable on /load; profiler accepts `filters` (event scoping) and maps are uniformly typed per column.

## Constitution Check

| # | Principle | Status | Evidence |
|---|-----------|--------|----------|
| I | Service Isolation | PASS | One new CubeJS REST route (additive), one new pre-processor rule (in-code), template conventions (data). No Actions/Hasura/client-v2 contract changes; discovery contract documented for client-v2 consumption later. |
| II | Multi-Tenancy | PASS | Discovery runs behind `checkAuthMiddleware` (datasource header + JWT) and scopes every probe with the security context's partition — same enforcement class as run-sql. R3 only rewrites queries; 013's scoping guarantees are untouched. |
| III | TDD | PASS (enforced in tasks) | Failing tests first for: R3 rewrite + slot exhaustion, discovery probe/shape/cache/tenancy, explicit-mode pruning, FILTER_PARAMS compile gate. StepCI E2E for the full discovery→compose→query loop. |
| IV | Security by Default | PASS | Discovery: JWT + datasource-scoped, admin paths unchanged, probe SQL is parameterized against key injection (keys are data, quoted/escaped). R3 never widens access: slots are ordinary members governed by existing access lists. |
| V | Simplicity/YAGNI | PASS | Reuses pre-processor, profiler, templates, rollout. Rejected heavier options documented (research addendum). One complexity item below. |

## Project Structure

```text
specs/014-dynamic-map-json-access/
├── spec.md, plan.md, tasks.md, examples.md   # examples.md is a DELIVERABLE (FR-012)

services/cubejs/src/
├── routes/
│   ├── dynamicMeta.js            # POST /api/v1/meta/dynamic — discovery (FR-005..007)
│   └── index.js                  # MODIFIED: mount (checkAuth-gated)
├── utils/
│   ├── defaultModelRules.js      # MODIFIED: R3 slot rewrite + slot-exhaustion rejection (FR-001,003,004)
│   ├── defaultModelMeta.js       # MODIFIED: member map gains slot registry (meta.param_slot) per cube
│   ├── dynamicPropertyProbe.js   # probe SQL builders + result shaping + TTL cache (FR-005,007)
│   └── errorCodes.js             # MODIFIED: + DYNAMIC_KEY_SLOTS_EXHAUSTED (013 conventions)
└── utils/smart-generation/
    └── cubeBuilder.js            # MODIFIED: field_policy: explicit prune-only mode (FR-008,009,010)

tests/workflows/default-models/dynamic-access.yml
```

**Template conventions (data, not code)** — documented in examples.md and the template authoring guide:
- Slot pair: `meta.param_slot: {map: dimensions, role: key|value, slot: a}` on declared members; value member SQL uses `FILTER_PARAMS.<cube>.<keyMember>.filter(...)`.
- Registry: under `field_policy: explicit`, the template's declared members ARE the registry; `meta.registry_key: <map>.<key>` / `meta.registry_path: properties.<path> (<type>)` drive per-team pruning probes.
- Event scope: template `sql: SELECT * FROM cst.semantic_events WHERE event = '<name>'` (partition baked by generation as today); generation passes the same event filter to the pruning probe.

## Complexity Tracking

| Addition | Why Needed | Simpler Alternative Rejected Because |
|----------|------------|--------------------------------------|
| Discovery endpoint + probe cache | FR-005/SC-001: composers need a filter-scoped, member-shaped directory of what exists NOW; nothing in Cube meta can express row-dependent availability | *Reuse /meta*: static, model-only, cannot see unregistered keys. *Client probes CH directly*: bypasses tenancy enforcement and semantics; duplicates scoping logic in every client. |

## Decisions inherited/confirmed

- Unknown key under current data → empty groups (SQL-natural), NOT an error; discovery is the guard rail. Deterministic errors reserved for structural problems (slot exhaustion).
- REST result columns carry slot member names (no per-query aliasing on REST) — composer maps back via request context; documented with examples.
- Multi-key beyond slot count: raise slots in the template (explicit decision) or use the SQL API. No automatic fallback.
