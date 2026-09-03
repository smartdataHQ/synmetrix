# Scope: Trim generated-model meta (smart-gen + template probe pipeline)

**Date**: 2026-07-07 · **Status**: IMPLEMENTED 2026-07-08 (branch `chore/smart-gen-meta-trim`) · **Repo**: synmetrix (primary), cxs2 (docs/conventions only)

> Owner decisions taken at implementation: lc cap = 12; `unique_values` exact ≤ 12 else 2 significant figures; **`meta.description` → Cube-native `description` moved INTO scope** (member + cube level, owner directive — "the current way is just stupid"); trim lands before the fully-managed-models work.
> Live results (local dev stack, doc-anchor datasource): per-field meta 9.0 → 3.8 lines; zero `range`/`raw_type`/`max_array_length`/`known_keys`/`refresh_cadence`; UUID guard verified on `account_id`; `store_format` keeps its complete 8-value enum; 158,604 → `unique_values: 160000`; applied model queryable (Discount Supermarket = 82,180, doc anchor); reconcile run 2 = all `skipped_no_change` (idempotent). Known separate issue: probe KEY INVENTORY can flap on rare map keys (profiler sampling — `holiday_name` appeared in one run, not the next); pre-existing, now the only churn source, follow-up candidate.
**Problem owner**: Stefán · **Origin**: generated models are ~⅔ meta by volume; per-field meta carries redundant type/provenance info and volatile value snapshots (ranges, enum lists, cardinality counts) that go stale immediately and churn managed-model versions on every reconcile.

## Measurements (local dev stack, 2026-07-07)

| File | Lines | KB | Field-meta lines | Enumerated-value lines |
| --- | --- | --- | --- | --- |
| wizard cube, 1 event type, 104 dims (`e2e_smoke_mrb8rfo2.yml`) | 1,501 | 60 | 954 (64%) | 263 |
| managed `semantic_events.yml` (template + probe members) | 3,372 | 121 | 2,294 (68%) | 1,027 |

Concrete rot examples: `received_at` range frozen at a 26-second window (`2026-03-29T12:37:08.168 → 12:37:34.386`); 8 raw user UUIDs baked into `user_id.meta.lc_values` (PII-adjacent); `abstract_event` enum of 32 values that grows weekly; parent map description duplicated verbatim onto every expanded key (38× in one file).

Churn mechanism: `reconcileTeam.js:255` no-change guard compares exact code strings; volatile stats shift whenever data arrives → near-every reconcile mints a new version per team.

## Principle

**The model carries shape + semantics; values live in the data plane.** Anything a consumer can ask the data for at use time (distinct values, ranges, key inventories) is not baked into the model. Existing live surfaces already cover every need: filter values via live queries (FilterBuilder pattern / `/column-values`), map keys via `POST /api/v1/meta/dynamic` (014, TTL-fresh), profiling via `/profile-table`.

## Goals

1. Cut generated file size ~50–60%; kill per-field noise.
2. Make generation idempotent w.r.t. data drift → managed-model reconciles stop minting no-op versions (prerequisite for the upcoming "fully managed models" class).
3. Stop baking PII-shaped values (identifier lists) into schema files.
4. Zero capability regression for the verified consumers listed below.

## Non-goals

- No change to the PROFILE pipeline or wizard refinement UX — the SSE profile keeps full stats (ranges, up to 60 LC values, array lengths); the wizard's ColumnDetailPanel renders the profile, not baked meta.
- No change to template/param-slot machinery (`param_slot`, `from_template`, `default_model`, `template_checksum`) — 013/014 and cxs2 079 depend on these.
- No new endpoints. No cxs2 behavior changes (docs/conventions only).

## Key-by-key disposition

Verified consumers as of 2026-07-07 (grep across synmetrix `services/cubejs/src`, cxs2 `src`, semantic-layer skill).

### Field-level — DROP (zero readers of the baked copy)

| Key | Emitted at (cubeBuilder.js) | Evidence |
| --- | --- | --- |
| `range` {min,max,avg} | :709–711, :725–726 | No reader in either repo. Wizard shows ranges from profile. |
| `raw_type` | :679–682 | Only wizard profile UI reads `raw_type` (transient profile field, not baked meta). |
| `max_array_length` | :713–715 | Wizard profile UI only. |
| `known_keys` (native `_map` dims) | :780 | No reader; superseded by `/meta/dynamic` (fresher, TTL-stamped, filter-scoped). |
| per-key `description` copied from parent map column | :694–697 (map-expanded branch) | Pure duplication (38× in managed file). Keep description on the native `_map` dim + non-map fields. |
| `title` when equal to plain humanization | :927–928, :1313–1314 (`titleFromName`) | Cube derives the same title. Emit ONLY when `titleFromName` differs from Cube's default humanization (acronym cases: "Entity GID" vs "Entity Gid" — keep those). |

### Field-level — BOUND (readers need coarse/bounded info, not snapshots)

| Key | Disposition | Readers that constrain it |
| --- | --- | --- |
| `unique_values` | Exact when ≤ 12; else round to 2 significant figures (e.g. 8,314 → 8,300). Kills churn; preserves every threshold in use (7 pie, 12 facet, 50 searchable, 500 list, 2000 lazy). | cxs2 `discover.ts:73–103` (lazy gate), `cube-meta-client.ts:261/318/342/372` ×2 copies (chart-type inference, facets), `cubeMetaToFields.ts:154/176` |
| `lc_values` | Cap 60 → **12**, and attach ONLY when the full distinct set fits (uniqueValues ≤ 12) — a truncated list masquerading as an enum misleads facet UIs. Add identifier-shape guard: skip when values match UUID/ULID/hex/email patterns regardless of count (fixes the `user_id` PII case). Keep for genuinely enumerable dims (status/tier/category) — facet discovery (`discoverFacetDimensions`, maxValues=12) and agent filter-hints need real values. | cxs2 `cube-meta-client.ts:376–382` ×2, `discover.ts:113`, `CompetitorPricingFilters.tsx:41` (FILTER_PARAMS dims can't be live-queried), skill `meta-conventions.md:180` |
| `known_values` (nested lookup keys) | Keep (agents can't compose the FILTER_PARAMS lookup pattern without valid values; sets are small/stable — entity types), same identifier guard + 12 cap. | `CompetitorPricingFilters.tsx:41`, lookup SQL pattern itself |

### Field-level — KEEP AS-IS (load-bearing)

`auto_generated`, `ai_generated` (merger.js:20/27 — user-vs-generated field distinction on regeneration), `source_column` (smartGenerate.js:611–617 AI-metric survival + used-column tracking), `map_key` + `source_group` (diffModels.js:29–31 change-preview source tags), `nested_lookup_key`, `field_type` (cxs2 chart-type inference `cube-meta-client.ts:259`; keep this one, drop `raw_type`), `filtered_count_for` (cubeBuilder pruning).

### Cube-level

| Key | Disposition |
| --- | --- |
| `source_database/source_table/source_partition`, `generation_filters` | Keep — re-generation reads them (`smartGenerate.js:697–698`); merger provenance set (merger.js:283–291). |
| `grain`, `grain_description`, `time_dimension`, `time_zone` | Keep — consumed by cxs2 dashboards + MCP discover (`discover.ts:52/173/258`, `cube-meta-client.ts:418–422`) and the propose gate (`validate-proposal.ts:54`). |
| `generated_at` | Keep — one line per cube, provenance value; not emitted by the template pipeline so no reconcile churn. |
| `refresh_cadence` | **Drop** — zero readers. Must ALSO be added to a legacy-cleanup list in merger (see below) or it survives forever as a "user key". |
| `description` (tableDescription) | Keep. |

## Code changes (synmetrix)

1. **`utils/smart-generation/cubeBuilder.js`** — the only emission site:
   - Field loop :671–741: drop `raw_type`/`range`/`max_array_length`; per-key description suppression; `unique_values` bucketing helper; `lc_values`/`known_values` cap + identifier-shape guard (new small helper, e.g. `looksLikeIdentifierValues(values)`).
   - Native map block :763–785: drop `known_keys` (keep `native_map`, `field_type: 'map'`, description).
   - Cube meta builders (~:930–996, :1316–1334): drop `refresh_cadence`.
   - Title stamping :927–928/:1313–1314: emit only when differing from Cube's default humanization.
   - `buildCubesFromTemplate` probe-member path reuses the same field pipeline — verify no separate emission site remains (:1570ff).
2. **`utils/smart-generation/merger.js`**:
   - Cube-level: add dropped legacy keys (`refresh_cadence`) to the provenance/regenerate set (:283–291) so existing files shed them on next merge instead of preserving them as user keys.
   - Field-level: no change — auto fields are wholesale-replaced (`mergeFields` :157–210), so trimmed meta self-heals on regeneration/reconcile.
3. **`utils/smart-generation/profiler.js`**: no functional change (LC probe stays at 60 for the wizard profile). Identifier-shape helper may live beside `buildRange` in cubeBuilder instead.
4. **Tests** (repo's own suites): update assertions in `__tests__/lcProbe.test.js` (:164–252), `cubeBuilder.test.js` (:150–152 keeps `generated_at`), `templateMode.test.js` (:188), merger/aiMetricMerge tests. Add cases: identifier-guard, lc cap, unique_values bucketing, title suppression, reconcile no-change on unchanged data (idempotency — the headline behavior).
5. **`routes/reconcileTeam.js`**: no code change; verify `skipped_no_change` now actually fires across two consecutive reconciles with static data (e2e assertion).

## Coordinated changes (cxs2 — no behavior change required)

- `src/lib/services/semantic-layer/model-validation/completion/meta-conventions.ts` (:56–57) — update key descriptions (bucketed `unique_values`, lc cap 12, removed keys no longer suggested).
- Semantic-layer skill `references/meta-conventions.md` (:172–185) + `qa_gate.py` / `validate_cube_model.py` — align documented conventions; the skill already says "lc_values only when truly enumerable — never identifiers", which the generator currently violates; after the trim the generator matches the skill.
- `discover.ts`, `cube-meta-client.ts` ×2, `cubeMetaToFields.ts` — **no edits**: all threshold logic keeps working with exact-≤12 / bucketed values, absent keys already have fallbacks (verified: every read is `typeof x === 'number'`-guarded or `?? -1`).

## Migration / rollout

- No data migration. Wizard models shed fat meta on next regeneration (auto fields wholesale-replaced); managed models shed it on next reconcile per team. User-edited (non-auto) fields keep whatever meta they have — by design (user content is never touched).
- Old + new files coexist safely: no consumer requires the dropped keys (verified above).
- Deploy: synmetrix cubejs service only; no Hasura/actions/schema change; no cxs2 deploy dependency.

## Verification (owner rules: live e2e, no mocks)

1. Regenerate the 079 e2e anchor cube (Sómi, `Sales Report Submitted`) → assert: file < ~40% of previous size; no `range`/`raw_type`/`known_keys`; `user_id` has no `lc_values`; `store_format` keeps its 8 values; facets/chart-inference still work on a dashboard bound to it.
2. Reconcile twice with static data → second run reports `skipped_no_change` for all templates (idempotency).
3. cxs2 079 suites US2–US4 stay green (dynamic discovery path untouched).
4. Tychi `cube_discover fields` on the regenerated cube: context size measurably down, lazy-gate behavior unchanged.

## Open decisions (owner)

1. `lc_values` cap = 12 (matches facet maxValues) — or keep a higher bake cap (e.g. 20) for agent hints?
2. `unique_values` bucketing = exact ≤12, 2-sig-fig above — acceptable threshold wobble at bucket edges?
3. Phase 2 candidate (separate): move member `meta.description` → Cube-native `description` (would surface in standard Cube tooling and Explore; touches annotation consumers) — in or out?
4. Should the trim land before or together with the "fully managed models" work? (Trim is a prerequisite for meaningful managed-version history either way.)

## Forward relevance ("fully managed models", discussion upcoming)

The trim is foundational for the two-class model (Manual per-datasource vs Managed built-in SL: `semantic_events`, `data_points`, `sales_data`, `entities`, `time_series`): managed reconciles become idempotent (version history = real template changes only), derived files become small enough for cheap fleet-wide re-derivation and diffing, and value-freshness concerns move wholly to the data plane (dynamic discovery), where the managed class needs them anyway.

## Estimate

Synmetrix: ~1 day incl. test updates + live verification. cxs2/skill doc sync: ~1 hour. No coordination hazard (either order deploys safely).
