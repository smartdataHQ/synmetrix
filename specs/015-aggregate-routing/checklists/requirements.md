# Specification Quality Checklist: Aggregate-Aware Query Routing

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-11-20
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- Validated in one pass on 2026-11-20.
- The spec speaks of "the database", "aggregate tables", "grouping columns" and "maps of named values" because the feature is about database-level aggregates; no product, language or file is named in the requirements.
- Owner direction of 2026-11-20 is built into the spec (see its header and Assumptions):
  1. Lag is acceptable; this is mostly for historical data.
  2. Deduplication is the database's own; nothing reads with duplicate removal.
  3. Historical data is exact as soon as it is stable.
  4. The age from which data is summarised is declared per aggregate.
  5. Aggregate and source are not combined. A long window is answered from the aggregate and its newest data may be wrong; short windows that include now read the source.
  6. An answer served from an aggregate carries a mark with the time through which the aggregate holds data (decided with the dashboard work, cxs2 spec 290 section 5.1; added to the spec on 2026-11-20 as FR-030 and SC-009).
- Members that cannot be reproduced exactly (for example a minimum over a sparsely populated map key) stay on the source; nothing changes meaning.
- Scope was trimmed on 2026-11-20 to what was asked for: no operator endpoints, no row-count estimation, no stored distinct-count states, UTC-bucketed queries only.
- The source-table setting that makes old periods consolidate was switched on for the first candidate on the development cluster on 2026-11-20 at the owner's request.
- SC-002 uses measurements from the first test candidate (2026-11-20 query log) as the baseline.
