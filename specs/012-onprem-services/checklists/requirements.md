# Specification Quality Checklist: On-Prem Services

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-06-10
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

- Key design decisions were resolved in the preceding working session and are
  encoded as requirements/assumptions rather than open clarifications:
  central platform is the sole identity-assertion issuer; all users live in
  the one central pool (per-customer identity environments explicitly
  rejected); verification on customer hardware uses public material only;
  account standing is enforced via periodic status checks with a 72-hour
  grace window, not via per-request central dependency.
- "Single-host and Kubernetes variants" in FR-015 names deliverable formats
  requested by the stakeholder, not an implementation choice.
- Spec spans two systems (central platform and the packaged solution);
  planning should split work accordingly (central registry + assertion
  issuance vs. instance-side sign-in, standing gate, and packaging).
- Stakeholder amendments encoded 2026-06-10: (1) hosted Synmetrix is
  explicitly unaffected — strengthened FR-008 plus SC-008 regression
  criterion; (2) the central platform is a configurable, relocatable gateway
  (app.fraios.dev today, .com/.ai later) — new FR-018, gateway-move edge
  case, and assumption that no shipped artifact hardcodes the address.
- Stakeholder amendments encoded 2026-06-11: instance credential v1 uses the
  central platform's existing account-scoped key store as-is (no hashing or
  scope-gating retrofit); capability confinement arrives with the platform's
  planned WorkOS API keys + FGA work, transparently to deployed instances
  (FR-010 rephrased, SC-001 blast-radius rewording). Central-side changes
  are additive only and coordinated around in-flight platform development —
  do not branch or modify the central platform repo as part of this
  feature's instance-side work.
