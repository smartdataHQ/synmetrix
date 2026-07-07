# Feature Specification: Mature Default Models

**Feature Branch**: `013-mature-default-models`
**Created**: 2026-07-06
**Status**: Draft
**Input**: User description: "Mature Default Models"

Every account on the platform has access to the same commonly-available data (behavioral/semantic events, scoped per account). Today, new teams receive a one-time seed of default models; after that the platform has no way to keep those models correct, current, or consistent. This feature matures that seeding into a managed lifecycle: the platform team (fftech.is) maintains a catalog of **global templates**, and the system continuously ensures that **each team owns its own working models derived from those templates** — tailored to the team's actual data, kept up to date as templates and data evolve, preserving the team's own customizations, and never leaving a team with a broken model set — deliberate breaking template changes (removed or renamed fields) are surfaced per team in a rollout report rather than happening silently. Queries against these default models pass through a fixed, platform-defined pre-processing step — applied before standard query validation — so canonical queries work for every team even though each team's variant differs.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Every team owns tailored default models (Priority: P1)

The platform team publishes a catalog of global templates for the commonly-available data. The system guarantees that every team — new or existing — owns a set of models derived from those templates. Each team's derived models are tailored to that team's actual data: only fields, event types, and value sets that actually occur in the team's data appear in their models, and every derived model is scoped so the team can only ever see its own data. Derived models belong to the team like any other model: they appear in the team's workspace, are versioned in the team's history, and are queryable immediately.

**Why this priority**: This is the core promise — "we make sure each team owns models based on these global templates." Without it nothing else in the feature has meaning. On its own it already delivers value: every account gets working, account-accurate analytics models with zero setup.

**Independent Test**: Create a fresh team with data present in the common store; verify the team owns one derived model per published template, that the models reflect only that team's data, and that queries return only that team's rows.

**Acceptance Scenarios**:

1. **Given** a new team is created, **When** onboarding completes, **Then** the team owns derived models for every published template, tailored to its data, and can run queries against them successfully.
2. **Given** an existing team that predates this feature, **When** reconciliation runs, **Then** the team receives its derived models without any action on its part.
3. **Given** two teams whose data differs (different event properties, different value sets), **When** their derived models are generated, **Then** each team's models expose only fields present in that team's data, and each team's queries return only that team's data.
4. **Given** a team with no data yet in the common store, **When** reconciliation runs, **Then** the team receives minimal skeleton models derived from the templates, and no error occurs.

---

### User Story 2 - Template updates propagate safely to all teams (Priority: P2)

A platform admin edits a global template and publishes the update. The system rolls the change out to every team's derived models in stages: a canary cohort first, then the wider fleet. Each team's updated models are validated before they go live for that team; a team whose update fails validation keeps its previous working models and is reported, without affecting any other team. Teams where nothing effectively changes get no update at all.

**Why this priority**: Central maintenance is the reason templates exist — the platform team must be able to improve the defaults for everyone without hand-touching N accounts and without the risk of breaking them all at once.

**Independent Test**: Publish a template change; verify staged propagation, per-team validation, that a deliberately-broken team is skipped and reported while others converge, and that unchanged teams record no new version.

**Acceptance Scenarios**:

1. **Given** a published template update, **When** the rollout completes, **Then** every participating team's derived models reflect the update.
2. **Given** a team whose updated models fail validation, **When** the rollout reaches that team, **Then** the team's previous models remain live, the failure is reported to platform admins, and the rollout continues for other teams.
3. **Given** a staged rollout, **When** failures in the canary cohort exceed a configured threshold, **Then** the rollout halts before reaching the remaining teams.
4. **Given** a team for which the update produces no effective change, **When** reconciliation runs, **Then** no new version is recorded for that team.

---

### User Story 3 - Derived models track each team's evolving data (Priority: P3)

As a team's data evolves — new event types appear, new properties start being recorded, value sets change — scheduled reconciliation detects the drift and refreshes that team's derived models to match reality. Models never advertise fields that don't exist in the team's data, and newly-arrived data becomes explorable without anyone editing a model.

**Why this priority**: Tailoring is only valuable if it stays true over time; stale defaults erode trust in the whole catalog. Depends on US1 being in place.

**Independent Test**: Introduce new properties into a team's data slice; verify the next reconciliation exposes them in the team's derived models, and that a team with unchanged data records no new version.

**Acceptance Scenarios**:

1. **Given** new properties appear in a team's data, **When** the next scheduled reconciliation runs, **Then** the team's derived models expose the new properties.
2. **Given** a team whose data has not changed since the last run, **When** reconciliation runs, **Then** no new model version is recorded for that team.

---

### User Story 4 - Team customizations survive, with visible provenance (Priority: P4)

Teams may extend their derived models — adding their own fields, descriptions, and related models. Reconciliation and template rollouts preserve team-added content. Every system-made change is attributed to a distinct system identity in the team's version history, so teams can always tell which changes were theirs and which were the platform's, and can roll back through their normal version history.

**Why this priority**: Ownership without safety is a trap — if refreshes destroyed team work, teams would fork away from the managed models and the guarantee would collapse.

**Independent Test**: Add a custom field to a derived model, trigger reconciliation and a template rollout, verify the custom field survives both and the history distinguishes system versions from team versions.

**Acceptance Scenarios**:

1. **Given** a team has added custom fields to a derived model, **When** reconciliation or a template rollout updates that model, **Then** the team-added fields are preserved.
2. **Given** a system-made update to a derived model, **When** the team inspects version history, **Then** the update is attributed to the system identity, distinct from team members.
3. **Given** a team-edited field that the template also owns, **When** an update arrives, **Then** the template's definition replaces the team's edit (template wins), the replacement is visible in the team's version history, and any team-added fields remain untouched.

---

### User Story 5 - Canonical queries work for every team (Priority: P5)

Dashboards, integrations, and platform tooling issue canonical queries against the default models. Because each team's variant differs, a fixed, platform-defined pre-processing step adapts each incoming query to the executing team's variant **before the query undergoes standard validation** — translating canonical references, enforcing mandatory account scoping, and handling references to fields a given team's variant lacks according to fixed rules. The rules apply exclusively to default models; queries touching only team-authored models are passed through untouched.

**Why this priority**: This is what makes the default models a platform *product* — one dashboard, one integration, one documented query shape that works for every account. Valuable only once US1–US3 exist.

**Independent Test**: Run one canonical query suite against multiple teams with differing variants; verify each team gets correct, team-scoped results, that a reference to a field absent in one team's variant is handled per the fixed rules with a clear outcome, and that queries against team-authored models are not modified.

**Acceptance Scenarios**:

1. **Given** a canonical query referencing default-model fields, **When** it is executed on behalf of any team, **Then** it is adapted to that team's variant before validation and returns that team's data only.
2. **Given** a query referencing a default-model field absent from the executing team's variant, **When** it is pre-processed, **Then** the fixed rules produce a deterministic outcome (adaptation or a clear, specific rejection) before standard query validation runs.
3. **Given** a query that references only team-authored models, **When** it is executed, **Then** the pre-processing rules do not alter it.

---

### Edge Cases

- **Empty account**: a team with no rows yet in the common data store receives skeleton models (template structure, no data-derived fields) rather than an error; the next reconciliation after data arrives fills them in.
- **Deleted derived model**: a team deletes a derived model without opting out of its template — the model is recreated on the next reconciliation. To make a deletion stick, the team opts out of that specific template first; opted-out templates are neither recreated nor updated for that team.
- **Name collision**: a published template's model name collides with a model the team authored independently — the team's model is never overwritten; the collision is skipped and reported to platform admins (see FR-019).
- **Partial fleet failure**: reconciliation fails for some teams (data store unreachable for their slice, validation failure) — remaining teams proceed; failures are isolated and reported per team.
- **Retired template**: the platform retires a template — existing derived models remain owned by teams but are no longer managed (no further updates), and are marked as unmanaged.
- **Concurrent edit**: a team member saves an edit to a derived model while reconciliation is updating it — one write wins cleanly via the existing versioning model (each write is a new version; no corruption), and the next reconciliation converges the result.
- **Scale**: the platform grows to hundreds of teams — a full reconciliation pass completes within its window without degrading query performance for teams (see SC-006).

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Platform admins MUST be able to author, edit, version, and publish global templates using the same model-authoring experience used for ordinary models.
- **FR-002**: The system MUST ensure every team owns one derived model set per published template: created automatically at team onboarding, and backfilled for existing teams by reconciliation.
- **FR-003**: Derived models MUST be owned by the team — appearing in the team's workspace, versioned in the team's history, and governed by the team's existing permissions — indistinguishable in handling from team-authored models except for provenance marking.
- **FR-004**: Derived models MUST be tailored per team from that team's actual data in the common store: only fields, event types, and value sets present in the team's data appear in the team's models.
- **FR-005**: Every derived model MUST be scoped to its owning team's data such that queries through it can never return another team's data.
- **FR-006**: Derived models MUST carry provenance identifying the source template and the template version they were derived from, distinguishable from team-authored content.
- **FR-007**: Reconciliation MUST run (a) on a schedule, (b) when a template is published, and (c) when a team is created.
- **FR-008**: Reconciliation MUST be convergent and idempotent: when neither the template nor the team's data has effectively changed, no new model version is recorded for that team.
- **FR-009**: Reconciliation MUST validate each team's updated models before making them live for that team; on validation failure the team's previous models remain live and the failure is reported.
- **FR-010**: Template rollouts MUST proceed in stages (canary cohort first) and MUST halt automatically when failures exceed a configured threshold.
- **FR-011**: Team-added content on derived models (fields, descriptions, related models) MUST be preserved across reconciliations and template rollouts.
- **FR-012**: When a team has edited template-owned content, the next update MUST converge that content to the template (template wins); the replacement MUST be visible in the team's version history, and team-added content MUST remain unaffected. Teams customize by adding their own content, not by editing template-owned content.
- **FR-013**: Teams MUST be able to opt out of default models per template. Opted-out templates are neither created, recreated, nor updated for that team. Deleting a derived model without opting out MUST result in the model being recreated on the next reconciliation.
- **FR-014**: All system-made changes to a team's models MUST be attributed to a distinct system identity in the team's version history.
- **FR-015**: Queries that reference default models MUST pass through a fixed, platform-defined pre-processing step applied **before standard query validation**; the rules MUST apply exclusively to default models and MUST NOT alter queries that touch only team-authored models.
- **FR-016**: The day-one pre-processing rule set MUST include both (a) mandatory account-scoping enforcement — verifying or injecting the executing team's data scope — and (b) canonical-reference translation — adapting canonical field references to the executing team's variant, with deterministic handling (adaptation or a clear, specific rejection) of references to fields the team's variant lacks.
- **FR-017**: Every reconciliation run MUST produce a report for platform admins listing, per team: updated / skipped (no change) / failed, with reasons.
- **FR-018**: A failure while reconciling one team MUST NOT affect any other team's models, queries, or reconciliation.
- **FR-019**: Derived models MUST NOT overwrite an existing team-authored model of the same name; collisions are skipped for that team and reported.
- **FR-020**: When a template is retired, existing derived models MUST remain with their teams, stop receiving updates, and be marked as no longer managed.

### Key Entities

- **Global Template**: a canonical model definition owned by the platform team; versioned; has a published/retired lifecycle. The source of truth for what every team's default models should contain.
- **Derived Model**: a team-owned model generated from a Global Template plus the team's data profile; carries provenance (template identity + version); accumulates team customizations; versioned in the team's own history.
- **Team Data Profile**: the observed shape of one team's slice of the commonly-available data — fields present, event types, value sets, ranges; the input that tailors a Derived Model.
- **Reconciliation Run**: one execution of the convergence process; records per-team outcomes (updated / skipped / failed with reason) and rollout stage.
- **Rollout Cohort**: an ordered grouping of teams for staged template propagation, beginning with a canary cohort.
- **Pre-processing Rule**: a fixed, platform-defined transformation applied to incoming queries that reference Derived Models, before standard query validation.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A newly created team can successfully query its default models within 10 minutes of onboarding, with zero manual setup.
- **SC-002**: After a template is published, 100% of participating teams' derived models converge to the update within 24 hours.
- **SC-003**: Zero teams are left with a broken model set by a template rollout: every team either compiles and serves its updated models successfully or keeps its previous working models and is reported. Template updates that remove or rename previously-published fields (which by policy CAN break existing queries — template wins) are detected and listed per affected team in the run report, so no dashboard breaks silently.
- **SC-004**: 100% of team-added customizations survive reconciliations and rollouts in acceptance testing.
- **SC-005**: A single canonical query suite executes successfully against every team whose data contains the referenced concepts; teams lacking a concept receive a deterministic, specific outcome rather than a generic validation error.
- **SC-006**: A full-fleet reconciliation pass at 500 teams completes within 4 hours without measurable query-latency degradation for teams during the run.
- **SC-007**: Teams with unchanged templates and unchanged data accumulate zero new model versions from reconciliation (no version churn).
- **SC-008**: Platform admins can answer "which teams are on the latest template, which are behind, and why" from a single report for any reconciliation run.

## Assumptions

- The commonly-available data lives in a shared analytical store partitioned per account; per-account probing of that store is reliable and efficient (confirmed by platform ownership of the store).
- The platform-owner team is fftech.is; its members act as platform admins for template authoring.
- A one-time default-model seeding mechanism already exists at team creation; this feature supersedes it with the managed lifecycle rather than running alongside it.
- Default models use a reserved naming convention so collisions with team-authored models are rare and detectable.
- Existing per-team version-history retention policies apply to versions created by reconciliation; no new retention rules are introduced by this feature.
- Rollback of a bad system update for a single team uses the team's existing version rollback capability.
- SC-001's 10-minute target is measured on the primary path (the onboarding-time reconcile). If that in-line trigger fails, the scheduled backfill (≤ 15-minute cadence) recovers the team automatically; that recovery path may exceed the 10-minute target and is an accepted trade-off.
- Teams opt out of a template (FR-013) through the existing team-settings surface (`update_team_settings`, owner-gated with protected-key stripping); no new opt-out API or UI is introduced by this feature.
