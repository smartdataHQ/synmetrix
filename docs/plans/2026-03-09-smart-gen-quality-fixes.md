# Smart Generation Output Quality Fixes

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 6 bugs in the smart model generation pipeline that cause incorrect types, corrupt lc_values, sparse meta, and naming errors.

**Architecture:** Fixes span 3 files in the pipeline: profiler.js (LC probing), fieldProcessors.js (type classification), cubeBuilder.js (meta enrichment). Each fix is independent and testable.

**Tech Stack:** JavaScript (ES modules), Node.js 18+, ClickHouse driver

---

## Bug Summary

| # | Bug | Root Cause | Impact | File |
|---|-----|-----------|--------|------|
| 1 | 66 metrics as string dimensions | MapFieldProcessor checks `valueType` (always OTHER) instead of `valueDataType` | All Map-expanded fields become strings regardless of actual Map value type | fieldProcessors.js |
| 2 | 33 flags as string dimensions | Same as #1 — `valueDataType` is BOOLEAN but never checked | Boolean map values mistyped | fieldProcessors.js |
| 3 | Grouped Array LC values corrupt | LC probe uses `groupUniqArray` on Array columns, returns arrays-of-arrays | `[[], ["Category"], ["Category", "Tag"]]` instead of `["Category", "Tag"]` | profiler.js |
| 4 | Int8→boolean too aggressive | `importance` (values 2,3,4) forced to `= 1` boolean | Wrong SQL, wrong type, wrong lc_values | fieldProcessors.js |
| 5 | lat/lon as `sum` measures | No coordinate detection — NUMBER type always → measure | Meaningless aggregation | fieldProcessors.js |
| 6 | Meta too sparse | Only `auto_generated` + `lc_values` | Missing source_column, raw_type, value_range, unique_values | cubeBuilder.js |

---

### Task 1: Fix MapFieldProcessor — use valueDataType

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/fieldProcessors.js`
- Test: `services/cubejs/src/utils/smart-generation/__tests__/fieldProcessors.test.js`

**The bug:** `MapFieldProcessor.process()` line 175 checks `columnDetails.valueType` which is always `ValueType.OTHER` for Map columns. Should check `columnDetails.valueDataType` which correctly holds NUMBER/BOOLEAN/STRING from the Map's declared value type.

**Step 1: Update MapFieldProcessor to check valueDataType**

Change the two conditionals in `MapFieldProcessor.process()`:
- `columnDetails.valueType === ValueType.NUMBER` → `columnDetails.valueDataType === ValueType.NUMBER`
- `columnDetails.valueType === ValueType.BOOLEAN` → `columnDetails.valueDataType === ValueType.BOOLEAN`

**Step 2: Update field processor tests**

Add test cases for Map(String, Float32) → numeric measures and Map(String, Bool) → boolean dimensions.

**Step 3: Run tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/fieldProcessors.test.js
```

---

### Task 2: Fix LC probing for grouped Array columns

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/profiler.js`
- Test: `services/cubejs/src/utils/smart-generation/__tests__/lcProbe.test.js`

**The bug:** LC probe uses `groupUniqArray(N)(col)` for all basic/grouped columns. For Array-typed grouped columns (e.g., `classification.type` which is `Array(String)`), this returns unique *array combinations* `[[], ["A"], ["A","B"]]` instead of unique individual elements `["A","B"]`.

**Step 1: Detect Array-typed grouped columns in LC candidate selection**

In the LC probe section (~line 583), mark grouped Array columns:
```js
const isArrayGrouped = col.columnType === ColumnType.GROUPED && col.rawType?.startsWith('Array(');
lcCandidates.push({ name, type: isArrayGrouped ? 'array_grouped' : 'basic' });
```

**Step 2: Generate correct SQL for array_grouped candidates**

Use `groupUniqArrayArray(N)` instead of `groupUniqArray(N)`:
```js
if (candidate.type === 'array_grouped') {
  selectParts.push(
    `arraySort(groupUniqArrayArray(${LC_THRESHOLD})(\`${candidate.name}\`)) as ${alias}__lc_values`
  );
}
```

**Step 3: Deduplicate and deep-clean LC values**

After filtering, also deduplicate: `[...new Set(values)]` and filter nested arrays/objects.

**Step 4: Run tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/lcProbe.test.js
```

---

### Task 3: Fix Int8 boolean heuristic

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/fieldProcessors.js`

**The bug:** All Int8 columns treated as boolean. `importance` has values 2,3,4 → generates `({CUBE}.importance) = 1` which is always false. `traits.age` is Int8 — age is NOT boolean.

**Step 1: Add isInt8Boolean helper**

```js
function isInt8Boolean(rawType, profile) {
  if (!rawType.toLowerCase().includes('int8')) return false;
  if (!profile) return true; // assume boolean without data
  if (profile.maxValue != null && profile.maxValue > 1) return false;
  if (profile.minValue != null && profile.minValue < 0) return false;
  if (profile.lcValues && Array.isArray(profile.lcValues)) {
    for (const v of profile.lcValues) {
      const n = Number(v);
      if (!isNaN(n) && n !== 0 && n !== 1) return false;
    }
  }
  return true;
}
```

**Step 2: Thread profile through determineFieldType, getCubeType, generateSqlExpression**

Replace `rawType.includes('int8')` checks with `isInt8Boolean(rawType, profile)` calls. Pass profile from BasicFieldProcessor and NestedFieldProcessor.

**Step 3: Run tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/fieldProcessors.test.js
```

---

### Task 4: Fix coordinate columns (lat/lon → dimensions)

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/fieldProcessors.js`

**The bug:** `location.latitude` and `location.longitude` are Float64 → NUMBER → `sum` measures. Summing coordinates is meaningless.

**Step 1: Add coordinate detection to determineFieldType**

```js
const name = (columnDetails.childName || columnDetails.name || '').toLowerCase();
if (/^(lat|latitude|lon|lng|longitude)$/.test(name)) {
  return 'dimension';
}
```

**Step 2: Run tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/fieldProcessors.test.js
```

---

### Task 5: Enrich field meta

**Files:**
- Modify: `services/cubejs/src/utils/smart-generation/cubeBuilder.js`

**The bug:** Meta only has `auto_generated` and `lc_values`. Missing source column info and numeric range data.

**Step 1: Add source info and profile data to meta**

In `processColumns()`, after creating `field.meta`:
```js
field.meta.source_column = columnName;
field.meta.raw_type = details.rawType;
if (profile && profile.uniqueValues > 0) field.meta.unique_values = profile.uniqueValues;
if (profile && profile.minValue != null) field.meta.min_value = profile.minValue;
if (profile && profile.maxValue != null) field.meta.max_value = profile.maxValue;
```

For Map-expanded fields, also add `map_key`.

**Step 2: Update cube builder tests**

**Step 3: Run tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/cubeBuilder.test.js
```

---

### Task 6: Integration verification

**Step 1: Run all unit tests**

```bash
node --test services/cubejs/src/utils/smart-generation/__tests__/*.test.js
```

**Step 2: Run integration test against real ClickHouse**

```bash
node scripts/test-smart-gen.mjs
```

**Step 3: Inspect generated YAML**

Verify:
- metrics_* fields are measures with `type: sum` and `CAST(... AS Float64)` SQL
- flags_* fields are boolean dimensions
- classification.type lc_values are flat: `["Category", "Tag"]`
- importance has `type: number` (not boolean) if values > 1
- location.latitude/longitude are dimensions
- Meta includes source_column, raw_type, value_range

---

## Execution Order

Tasks 1-4 are all in fieldProcessors.js and can be done together.
Task 2 is in profiler.js (independent).
Task 5 is in cubeBuilder.js (independent).
Task 6 is final verification.
