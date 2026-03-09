# Smart Generation Accuracy and Optimization Controls

**Goal:** Add the missing profiling accuracy and performance controls to the smart model builder, fix the current low-cardinality regression, and expose enough runtime detail for users to understand how a profile was produced.

**Why this plan exists:** The current smart-generation pipeline already has internal tuning for sampling and low-cardinality probing, but most of it is hard-coded and not reachable from the builder/API surface. The result is that users can limit model size with `max_map_keys`, but they cannot tune profiling accuracy vs speed for large tables.

**Observed gaps:**
- `LC_THRESHOLD` is hard-coded to `60`, while the spec requires low-cardinality enumeration for columns under `200` unique values.
- `sampleThreshold` exists in `profiler.js`, but is not accepted by Hasura actions, RPC handlers, or CubeJS routes.
- Sampling method is detected internally (`native` vs `subquery_limit`) but the final profiler result hard-codes `subquery_limit`, and the public profile response drops the field.
- The example output in `test-output/semantic_events.yml` depends on richer LC output than the current code path would reliably produce.

**Primary files in scope:**
- `services/cubejs/src/utils/smart-generation/profiler.js`
- `services/cubejs/src/routes/profileTable.js`
- `services/cubejs/src/routes/smartGenerate.js`
- `services/actions/src/rpc/profileTable.js`
- `services/actions/src/rpc/smartGenSchemas.js`
- `services/hasura/metadata/actions.graphql`
- `tests/stepci/smart_gen_flow.yml`
- `services/cubejs/src/utils/smart-generation/__tests__/profiler.test.js`
- `services/cubejs/src/utils/smart-generation/__tests__/lcProbe.test.js`

---

## Target Outcome

After this work:
- The builder exposes explicit profiling controls instead of silently using fixed thresholds.
- Default behavior matches the spec and the example `semantic_events` output more closely.
- Users can choose between faster previews and more accurate profiling runs.
- Profile responses show whether the run used full scan, native ClickHouse `SAMPLE`, or the fallback `LIMIT` strategy.

---

## Recommended Product Surface

Use one new input object for both profile and generation requests instead of adding several top-level scalars.

### New input object

```graphql
input SmartProfileOptionsInput {
  mode: String
  sample_threshold: Int
  sample_ratio: Int
  sample_limit_max: Int
  lc_threshold: Int
  enable_lc_probe: Boolean
}
```

### Mode semantics

Modes provide sane presets for the UI and keep the API simple for most callers.

- `balanced` (default)
  - `sample_threshold = 1000000`
  - `sample_ratio = 10`
  - `sample_limit_max = 200000`
  - `lc_threshold = 200`
  - `enable_lc_probe = true`
- `fast`
  - `sample_threshold = 100000`
  - `sample_ratio = 25`
  - `sample_limit_max = 100000`
  - `lc_threshold = 60`
  - `enable_lc_probe = true`
- `accurate`
  - `sample_threshold = 5000000`
  - `sample_ratio = 4`
  - `sample_limit_max = 1000000`
  - `lc_threshold = 200`
  - `enable_lc_probe = true`

### Override rules

- If `mode` is omitted, use `balanced`.
- Explicit scalar overrides win over the preset.
- If `enable_lc_probe = false`, skip all LC enumeration even if `lc_threshold` is set.
- `max_map_keys` remains a separate generation control because it affects model size, not profiling accuracy.

---

## Phase 1: Correctness Fixes Before New Controls

### 1. Restore low-cardinality behavior to spec

**Problem:** `LC_THRESHOLD` is fixed at `60`, which suppresses valid `lc_values` for columns with `61..199` unique values.

**Changes:**
- Replace the fixed `LC_THRESHOLD = 60` default with `DEFAULT_LC_THRESHOLD = 200`.
- Thread `lcThreshold` through all LC candidate selection and final filtering logic.
- Use the threshold consistently for:
  - scalar/grouped LC candidate selection
  - per-key Map string LC candidate selection
  - `groupUniqArray(...)` / `groupUniqArrayArray(...)`
  - final `values.length >= lcThreshold` guard

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/profiler.js`
- Test: `services/cubejs/src/utils/smart-generation/__tests__/lcProbe.test.js`
- Test: `services/cubejs/src/utils/smart-generation/__tests__/profiler.test.js`

### 2. Return the actual sampling method

**Problem:** The profiler detects `native` vs `subquery_limit`, then discards the value and always returns `subquery_limit`.

**Changes:**
- Persist `samplingMethod` and `sampleSize` outside the deep-profiling block.
- Return the real method in the profiler result.
- Add `sampling_method` to the route payload and Hasura output type.

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/profiler.js`
- Modify: `services/cubejs/src/routes/profileTable.js`
- Modify: `services/hasura/metadata/actions.graphql`
- Modify: `services/actions/src/rpc/profileTable.js`
- Test: `services/cubejs/src/utils/smart-generation/__tests__/profiler.test.js`

### 3. Fix the smart-generate summary payload while touching response contracts

**Problem:** `profile_summary.array_candidates` is returned as `[]` even though the spec describes it as a count.

**Changes:**
- Count array candidates from the profiled table in the generation route.
- Return a numeric `array_candidates` value in both `changed: false` and `changed: true` responses.

**Files:**
- Modify: `services/cubejs/src/routes/smartGenerate.js`
- Test: add or extend route-level integration coverage in `tests/stepci/smart_gen_flow.yml`

---

## Phase 2: Expose Profiling Controls Through the API

### 4. Extend Hasura actions and RPC handlers

Add `profile_options` to both public entry points.

**GraphQL changes:**

```graphql
type Query {
  profile_table(
    datasource_id: uuid!
    branch_id: uuid!
    table_name: String!
    table_schema: String!
    profile_options: SmartProfileOptionsInput
  ): ProfileTableOutput
}

type Mutation {
  smart_gen_dataschemas(
    datasource_id: uuid!
    branch_id: uuid!
    table_name: String!
    table_schema: String!
    array_join_columns: [ArrayJoinInput]
    max_map_keys: Int
    merge_strategy: String
    profile_options: SmartProfileOptionsInput
  ): SmartGenOutput
}
```

**RPC changes:**
- `services/actions/src/rpc/profileTable.js`
  - Accept `profile_options`
  - Forward it unchanged to `cubejsApi().profileTable(...)`
- `services/actions/src/rpc/smartGenSchemas.js`
  - Accept `profile_options`
  - Forward it unchanged to `cubejsApi().smartGenerate(...)`

### 5. Extend CubeJS routes

**Route changes:**
- `services/cubejs/src/routes/profileTable.js`
  - Read `profileOptions` or `profile_options` from the request body
  - Normalize into one JS object
  - Pass to `profileTable(...)`
- `services/cubejs/src/routes/smartGenerate.js`
  - Read `profileOptions` or `profile_options`
  - Pass to `profileTable(...)`

### 6. Keep request naming stable across both paths

Use existing casing conventions:
- GraphQL / Hasura input: `profile_options`
- CubeJS REST input: `profileOptions`

This avoids breaking the current GraphQL style while keeping REST payloads idiomatic with existing `arrayJoinColumns` / `maxMapKeys`.

---

## Phase 3: Refactor the Profiler Around a Real Options Object

### 7. Introduce a resolved profiler config

Create a small helper in `profiler.js`:

```js
function resolveProfileOptions(input = {}) {
  // apply preset
  // validate numeric bounds
  // merge explicit overrides
  // return normalized config
}
```

**Normalized config shape:**

```js
{
  mode: 'balanced',
  sampleThreshold: 1_000_000,
  sampleRatio: 10,
  sampleLimitMax: 200_000,
  lcThreshold: 200,
  enableLcProbe: true,
}
```

### 8. Replace hard-coded constants in the profiling path

Keep true engine constants internal:
- `BATCH_SIZE`
- `SINGLE_QUERY_LIMIT`

Move these out of the hard-coded user-behavior path:
- `DEFAULT_SAMPLE_THRESHOLD`
- `SAMPLE_RATIO`
- `SUBQUERY_LIMIT_MAX`
- `LC_THRESHOLD`

Use resolved config instead.

### 9. Validate inputs defensively

Reject invalid values at the route boundary or in the resolver helper:
- `sample_threshold < 0`
- `sample_ratio <= 0`
- `sample_limit_max <= 0`
- `lc_threshold <= 0`
- unknown `mode`

Return a 400-style error code with a specific message such as:

```json
{
  "code": "invalid_profile_options",
  "message": "sample_ratio must be greater than 0"
}
```

---

## Phase 4: Response Shape and UX Transparency

### 10. Expand profile response metadata

Add the following fields to `ProfileTableOutput`:
- `sampling_method: String`
- `profile_options: jsonb`

`profile_options` should contain the resolved options actually used, not just raw input. This matters because presets and overrides can change the final values.

Example:

```json
{
  "sampled": true,
  "sample_size": 200000,
  "sampling_method": "subquery_limit",
  "profile_options": {
    "mode": "balanced",
    "sample_threshold": 1000000,
    "sample_ratio": 10,
    "sample_limit_max": 200000,
    "lc_threshold": 200,
    "enable_lc_probe": true
  }
}
```

### 11. Surface the same transparency in `smart-generate`

At minimum, add these fields to `profile_summary`:
- `sampled`
- `sample_size`
- `sampling_method`
- `array_candidates`

This gives the generation result enough context for debugging without forcing the user to run a separate profile call.

---

## Phase 5: Testing

### Unit tests

**Profiler**
- `balanced` default uses `lc_threshold = 200`
- explicit `lc_threshold` override changes candidate selection
- `enable_lc_probe = false` skips LC SQL entirely
- `sample_threshold` override changes when sampling starts
- `sample_ratio` override changes native `SAMPLE 1/N` or fallback `LIMIT`
- `sample_limit_max` caps fallback sample size
- returned `sampling_method` reflects actual execution path

**LC probe**
- column with `142` unique values is included when `lc_threshold = 200`
- same column is skipped when `lc_threshold = 60`
- grouped array LC still flattens correctly with custom thresholds

### Contract tests

Update `tests/stepci/smart_gen_flow.yml` to cover:
- `profile_table` with `profile_options`
- `smart_gen_dataschemas` with `profile_options`
- response includes `sampling_method`
- generation summary includes numeric `array_candidates`

### Regression fixture verification

Re-run the local smart-generation fixture and compare:
- `test-output/semantic_events_profile.json`
- `test-output/semantic_events.yml`

Expected verification points:
- `classification_value` keeps `lc_values` under default `balanced`
- `sampling_method` is accurate
- `sample_size` matches the effective ratio and cap

---

## Phase 6: Documentation

Update these docs after implementation:
- `specs/004-dynamic-model-creation/contracts/hasura-actions.md`
- `specs/004-dynamic-model-creation/contracts/cubejs-routes.md`
- `specs/004-dynamic-model-creation/contracts/frontend-graphql.md`
- `specs/004-dynamic-model-creation/data-model.md`

Document:
- default `balanced` behavior
- meanings of `fast` and `accurate`
- override precedence
- accuracy tradeoffs of native sampling vs `LIMIT` fallback

---

## Suggested Execution Order

1. Fix correctness gaps in `profiler.js`:
   - restore `<200` LC default
   - return actual `sampling_method`
   - keep `sample_size` tied to the resolved config
2. Add `profile_options` to Hasura schema and RPC forwarding.
3. Thread normalized options through `profileTable` and `smartGenerate` routes.
4. Refactor `profiler.js` to use `resolveProfileOptions()`.
5. Update response payloads and contract tests.
6. Re-run the smart-generation fixture against `semantic_events`.
7. Update docs and examples.

---

## Acceptance Criteria

- Default smart-generation behavior emits LC metadata for columns with fewer than `200` unique values.
- Both profile and generation APIs accept explicit profiling controls.
- The profiler returns the real sampling method used.
- `smart-generate` returns a correct numeric `array_candidates` summary.
- The `semantic_events` fixture still produces stable YAML, and the profile output clearly explains the sampling strategy.

---

## Non-Goals

- Exposing low-level internal batching knobs such as `BATCH_SIZE` or `SINGLE_QUERY_LIMIT`
- Redesigning Map expansion behavior beyond the existing `max_map_keys` control
- Introducing frontend-only work in this repo; frontend UI changes should consume the new API surface after backend support lands
