# Quickstart: Mature Default Models (local dev)

**Prerequisites**: `./cli.sh compose up` running; ClickHouse reachable from containers — `etc/default-datasources.json` points directly at the Tailscale address (`100.87.250.36:8123`, Docker Desktop has Tailscale networking), so **no port-forward or bridge is needed**; at least two teams with different partitions and data in the common store.

## 1. One-time setup

```bash
# .env additions
DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID=<uuid>   # step 2 creates it
DEFAULT_MODELS_SYSTEM_USER_ID=<uuid>           # pick a UUID — the first reconcile run creates the users row for it
DEFAULT_MODELS_TARGET_DATASOURCE_NAME="Semantic Events"  # must match default-datasources.json entry
DEFAULT_MODELS_CANARY_TEAM_IDS=<fftech team uuid>
DEFAULT_MODELS_DRIFT_PROBES='[{"table":"cst.semantic_events","timeColumn":"timestamp"}]'  # optional until US3; empty = every team treated as changed
ACTIONS_CRON_SECRET=<random string>   # required — the /rpc dispatcher is unauthenticated; these RPCs demand this header
```

## 2. Author a template (as fftech.is admin, in the normal editor)

Create a "Global Templates" datasource under the fftech.is team (connection: the shared ClickHouse). Add a model, e.g. `semantic_events.yml`, marking template-owned fields:

```yaml
cubes:
  - name: SemanticEvents
    sql_table: cst.semantic_events
    meta: { default_model: true, template: semantic_events }
    dimensions:
      - name: partition
        sql: partition
        type: string
        meta: { from_template: true }
    measures:
      - name: count
        type: count
        meta: { from_template: true }
```

Save (creates a version — that checksum is the "published" template version). Put the datasource id in `.env`.

## 3. Run a reconciliation manually

```bash
curl -s -X POST http://localhost:3001/rpc/reconcileDefaultModels \
  -H "x-actions-cron-secret: $ACTIONS_CRON_SECRET" \
  -H 'Content-Type: application/json' -d '{"trigger":"manual"}' | jq
```

Expect: `runId`, `status: completed`, totals showing your teams `updated` (or `updated_skeleton` for data-less teams).

## 4. Verify per-team results

- Open a team's workspace → its default datasource → new version authored by the system user, containing `semantic_events.yml` **tailored to that team** (probe-derived dims present; `partition = '<team>'` baked into SQL; provenance meta stamped).
- Compare two teams: probe-derived fields should differ where their data differs.
- Query it: `POST /api/v1/load` with `SemanticEvents.count` under each team's JWT → only that team's rows.

## 5. Exercise the pre-processor

```bash
# canonical query, team lacking a variant member → deterministic 400 (not a generic validation error)
curl -s -X POST http://localhost:4000/api/v1/load \
  -H "Authorization: Bearer $TEAM_JWT" -H 'Content-Type: application/json' \
  -d '{"query":{"measures":["SemanticEvents.count"],"dimensions":["SemanticEvents.member_only_other_teams_have"]}}' | jq
# → { "code": "DEFAULT_MODEL_MEMBER_UNAVAILABLE", ... }

# team-only query → byte-identical pass-through (assert via debug logging)
```

## 6. Exercise policies

- **Customization survives**: add a team dimension to the derived model, re-run step 3 → field preserved, template fields converged.
- **Opt-out**: `updateTeamSettings` with `{"default_models":{"opt_out":["semantic_events"]}}` → next run reports `skipped_opt_out`; delete the model → stays deleted. Remove opt-out → recreated.
- **Collision**: create a team-authored `semantic_events.yml` (no provenance meta) in a fresh team → run reports `skipped_collision`, file untouched.
- **Retirement**: publish a template-branch version with one template file removed → next run stamps `default_model_unmanaged: true` in each team's derived-model meta and never touches its content again (FR-020).
- **Validation gate**: publish a deliberately broken template edit → canary cohort reports `failed`, run `halted`, teams keep working models.

## 7. Report

```bash
curl -s -X POST http://localhost:3001/rpc/getDefaultModelsReport \
  -H "x-actions-cron-secret: $ACTIONS_CRON_SECRET" -d '{}' | jq '.teamsBehind, .breakingChanges'
```

## Tests

```bash
# cubejs uses Node's built-in test runner (package.json "test" globs src/**/__tests__/*.test.js)
cd services/cubejs && npm test
# actions gets "node --test" in T005 (bare form — a directory arg breaks on Node 22 hosts,
# bare discovery works on both Node 20 (container) and 22)
cd services/actions && npm test
./cli.sh tests stepci      # includes tests/workflows/default-models/
```

## Measurement footnotes (T040/T041, final — recorded 2026-07-07)

- **Unit suites**: cubejs 583/585 pass (2 pre-existing `partition.test.js` failures unrelated to 013 — buildWhereClause code/doc mismatch predates this feature); actions 52/52 pass; error-code lint green.
- **Connectivity**: dev now targets ClickHouse DIRECTLY over Tailscale (`100.87.250.36:8123` in `etc/default-datasources.json` + existing dev datasource rows updated) — the historical `host.docker.internal:18123` port-forward/bridge is no longer required; the full US1 suite re-verified 14/14 with nothing listening on 18123.
- **StepCI E2E (all five workflows pass against the live dev stack + ClickHouse)**: `reconcile-team` 14/14, `rollout-halt` 16/16 (broken template → halted → report → retirement unmanaged stamp), `reconcile-noop` 9/9 (second schedule run: fleet-wide `skipped_no_change`, version head unchanged — SC-007), `customization` 22/22 (custom field survives template edit, system attribution, owner opt-out via `update_team_settings`, deletion sticks, removal recreates), `preprocessor` 21/21 (same canonical query scoped per team, absent member → `DEFAULT_MODEL_MEMBER_UNAVAILABLE`, team-only cube untouched — SC-005).
- **SC-001**: team creation → first successful `/api/v1/load` against the derived model = **5.9 s** (target 600 s). Single-team reconcile with a populated partition: ~0.5–9 s (probe-dominated). Legacy hasura-backend-plus JWTs exercise the userId→membership partition fallback ✓.
- **Pre-processor (contract guarantee 5)**: warm in-scope `/api/v1/dry-run` end-to-end p50 3.2 ms / **p95 3.7 ms** (n=30) — the whole request sits under the 10 ms budget allotted to the middleware alone. Scope filter (`SemanticEvents.partition equals [<team>]`) verified injected live.
- **SC-006**: extrapolated, not measured — full 500-team fleet not exercised pre-GA (accepted limitation). Dev fleet (~15 teams) full pass ≈ 1–2 min; idle pass is near-free (per-team checksum no-ops; with `DEFAULT_MODELS_DRIFT_PROBES` set, one `GROUP BY partition` query per table replaces per-team work entirely).
- **Design refinement from live testing**: the halt threshold (FR-010) counts **only `validation:`-class failures** — the sole failure class a rollout can cause. Environmental failures (`no_partition`, `target_datasource_unavailable`, connectivity/credential faults, probe timeouts, `preexisting_invalid_branch:`) are recorded and reported per team but never halt: they write nothing, say nothing about template quality, and would otherwise permanently halt small fleets (observed with real dev teams).
- **Gotchas fixed during live verification**: `branches.status` is a GraphQL enum — inline literals must be unquoted (`status: { _eq: active }`); Cube's YAML compiler expression-evaluates `{...}` in EVERY string scalar (incl. meta/sampled data values) — template mode deep-sanitizes braces out of prose (`sanitizeCubeProse`) and drops FILTER_PARAMS/jinja probe fields (`isTemplateSafeProbeField`); `updateTeamSettings` forwarded the caller's token to the settings mutation, which the `user` role can never satisfy — the write now uses the admin path after the RPC's own owner check (pre-existing platform bug, fixed); StepCI: this build supports no faker templates (use an env-injected `RUN_SEED`), Joi rejects the `.test` TLD in emails, and the CLI's network name (`synmetrix_default`) mismatches compose (`synmetrix_synmetrix_default`) — run the stepci container directly.
