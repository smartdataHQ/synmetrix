# Nested Structure Dynamic Lookup — Research Findings

**Problem:** ClickHouse nested/grouped columns (parallel arrays) like `location.*` store multiple entries per row, keyed by a lookup field (`location_of`). Current smart-gen creates flat dimensions (`location_latitude`, `location_label`) that return raw arrays — no way to query "give me the Vehicle's label" or "the Origin's latitude".

**Ideal syntax:** `location('Vehicle').label` or `location.Vehicle.label`

---

## 1. The Data Structure

The `location` group in `cst.semantic_events` is a set of 19 parallel arrays:

```
location.location_of:     ['Origin', 'Destination']     ← lookup key
location.latitude:         [64.123, 65.456]              ← parallel values
location.longitude:        [-21.89, -18.12]
location.label:            ['Reykjavik HQ', 'Akureyri']
location.country:          ['Iceland', 'Iceland']
location.region:           ['Höfuðborgarsvæðið', 'Norðurland eystra']
...
```

- Up to 2 entries per row (max_array_length = 2)
- `location_of` has 8 known values: `Destination`, `Dropoff`, `Origin`, `POI`, `Pickup`, `Trip`, `Vehicle`, + 1 more
- All sub-columns share the same array length per row — index 0 is one logical location, index 1 is another

**The ClickHouse SQL for lookup:**
```sql
-- Get Vehicle's label (single match → scalar)
arrayElement(`location.label`, indexOf(`location.location_of`, 'Vehicle'))

-- Get all labels where location_of = 'Vehicle' (multi-match → array)
arrayFilter(x -> x.1 = 'Vehicle', arrayZip(`location.location_of`, `location.label`))
```

---

## 2. Cube.js Capabilities for Dynamic Field Access

### 2.1 FILTER_PARAMS (query-time SQL injection)

Cube.js's primary mechanism for query-time parameterization. Injects filter values into SQL generation.

**Syntax:**
```yaml
sql: >
  SELECT * FROM table
  WHERE {FILTER_PARAMS.cube_name.dimension_name.filter('column_name')}
```

**Callback form** (returns custom SQL from filter values):
```javascript
FILTER_PARAMS.events.date.filter(
  (from, to) => `timestamp >= ${from} AND timestamp <= ${to}`
)
```

**Limitations:**
- Designed for the cube-level `sql` property (base query), primarily in WHERE clauses
- NOT designed for use inside individual dimension `sql` expressions
- Does NOT work with pre-aggregations
- If used multiple times, must wrap with `FILTER_GROUP(...)`
- Arguments arrive as SQL-quoted strings from the driver
- Cube.js docs consider heavy FILTER_PARAMS usage "bad practice"

### 2.2 Jinja/Python Templating (compile-time only)

YAML model files support Jinja2 with Python:

```yaml
dimensions:
  {% for loc_type in ['Vehicle', 'Origin', 'Destination'] %}
  location_{{ loc_type.lower() }}_label:
    sql: "arrayElement(`location.label`, indexOf(`location.location_of`, '{{ loc_type }}'))"
    type: string
    title: "{{ loc_type }} Label"
  {% endfor %}
```

**Limitation:** Evaluated at compile time, not query time. Cannot access query-time filters. Requires knowing the possible values ahead of time.

### 2.3 JavaScript Dynamic Model Generation (compile-time)

JS model files can programmatically generate cubes and dimensions:

```javascript
const locationTypes = ['Vehicle', 'Origin', 'Destination', 'Pickup', 'Dropoff'];

cube(`semantic_events`, {
  sql: `SELECT * FROM cst.semantic_events`,
  dimensions: locationTypes.reduce((dims, locType) => ({
    ...dims,
    [`location_${locType.toLowerCase()}_label`]: {
      sql: () => `arrayElement(\`location.label\`, indexOf(\`location.location_of\`, '${locType}'))`,
      type: `string`,
      title: `${locType} Location Label`
    },
    [`location_${locType.toLowerCase()}_latitude`]: {
      sql: () => `arrayElement(\`location.latitude\`, indexOf(\`location.location_of\`, '${locType}'))`,
      type: `number`,
      title: `${locType} Latitude`
    }
  }), {})
});
```

**Can also fetch values from DB at compile time:**
```javascript
asyncModule(async () => {
  // Query ClickHouse for known location_of values
  const types = await fetchLocationTypes();
  // Generate dimensions dynamically
});
```

**Limitation:** Fixed at compile time. Adding a new `location_of` value requires recompilation. But compile happens per-tenant via `context_to_app_id`, so this can be tenant-aware.

### 2.4 CTE + FILTER_PARAMS Pattern (query-time, documented recipe)

The Cube.js "Passing Dynamic Parameters" recipe uses CTEs to materialize filter values as columns:

```javascript
cube(`semantic_events`, {
  sql: `
    SELECT *,
      arrayElement(\`location.label\`, indexOf(\`location.location_of\`, loc_type)) AS resolved_label,
      arrayElement(\`location.latitude\`, indexOf(\`location.location_of\`, loc_type)) AS resolved_latitude,
      arrayElement(\`location.longitude\`, indexOf(\`location.location_of\`, loc_type)) AS resolved_longitude
    FROM cst.semantic_events
    CROSS JOIN (
      SELECT ${FILTER_PARAMS.semantic_events.location_type.filter(
        (val) => `${val} AS loc_type`
      )}
    ) AS loc_filter
  `,
  dimensions: {
    location_type: { sql: `loc_type`, type: `string` },
    resolved_label: { sql: `resolved_label`, type: `string` },
    resolved_latitude: { sql: `resolved_latitude`, type: `number` },
    resolved_longitude: { sql: `resolved_longitude`, type: `number` }
  }
});
```

**This is the closest to `location('Vehicle').label`** — query with `{ filters: [{ member: "semantic_events.location_type", operator: "equals", values: ["Vehicle"] }] }` and then select `resolved_label`.

**Limitations:**
- No pre-aggregation support
- Requires the filter to be present in every query
- CROSS JOIN adds complexity; ClickHouse may not optimize well
- Using FILTER_PARAMS in SELECT (not WHERE) is undocumented

### 2.5 Subquery Dimensions

Can reference measures from other cubes:

```javascript
dimensions: {
  users_count: {
    sql: `${users.count}`,
    type: `number`,
    sub_query: true,
    propagate_filters_to_sub_query: true
  }
}
```

**Not applicable here** — designed for cross-cube measure references, not array element extraction.

### 2.6 SECURITY_CONTEXT (deprecated)

```javascript
sql: `arrayElement(\`location.label\`, indexOf(\`location.location_of\`, ${SECURITY_CONTEXT.location_type.unsafeValue()}))`
```

**Not viable** — deprecated, SQL injection risk via `unsafeValue()`, couples data modeling to auth context.

---

## 3. ClickHouse Array Handling in Cube.js

From GitHub Issue #10048: Cube.js has **no native array type support**.

- Standard dimension filters append `= ?` which breaks array functions like `hasAny()`
- No `contains` operator for arrays in Cube.js filter syntax
- Workarounds: `arrayExists()` with lambdas, `arrayJoin()` to flatten, `arrayStringConcat()` to stringify

**Implication:** Even if we generate `location_vehicle_label` as a dimension, filtering on array-derived values may not work with Cube.js standard filter operators.

---

## 4. Multi-Match vs Single-Match Return Types

The user asked: "If more than one match, return array; if one match, return scalar."

**This is not possible in Cube.js.** A dimension has a fixed `type` — it cannot dynamically switch between `string` and `string[]` based on data. ClickHouse can do this at the SQL level:

```sql
-- Returns array (could be 0, 1, or N elements)
arrayFilter((k, v) -> k = 'Vehicle', `location.location_of`, `location.label`)
```

But Cube.js dimensions must declare a type. Options:
- Always return scalar (first match): `arrayElement(label, indexOf(location_of, 'X'))` — returns empty string if no match
- Always return array as string: `arrayStringConcat(arrayFilter(...), ', ')` — comma-joined
- Always return array as JSON: `toJSONString(arrayFilter(...))` — parseable but opaque to Cube.js

**Recommendation:** Use `arrayElement` (first match as scalar). The data shows max_array_length=2 and location_of values are categorical — typically one match per type per row.

---

## 5. Feasibility Assessment

| Approach | Query-Time Dynamic | Pre-Agg | Complexity | Reliability |
|----------|-------------------|---------|------------|-------------|
| A. Compile-time generation (JS/Jinja) | No (fixed set) | Yes | Low | High |
| B. CTE + FILTER_PARAMS | Yes | No | Medium | Medium |
| C. asyncModule + DB introspection | No (compile-time) | Yes | Medium | High |
| D. ARRAY JOIN cube variant | No (fixed) | Yes | Low | High |

### Approach A: Compile-Time Generation (Recommended)

Generate `location_vehicle_label`, `location_origin_latitude`, etc. at compile time from known `location_of` values. The profiler already discovers these values — they're in `profile.lcValues` for `location.location_of`.

**Pros:** Works with pre-aggregations, no FILTER_PARAMS complexity, reliable, each field has correct type.
**Cons:** Fixed set of location types. New types require recompilation (but `context_to_app_id` handles this).

**SQL pattern per generated dimension:**
```sql
arrayElement(`location.label`, indexOf(`location.location_of`, 'Vehicle'))
```

### Approach B: CTE + FILTER_PARAMS (Fallback)

For truly dynamic lookup where the set of keys is unbounded or frequently changing.

**Pros:** True query-time parameterization.
**Cons:** No pre-aggregation, CROSS JOIN overhead, undocumented FILTER_PARAMS usage in SELECT.

### Approach C: asyncModule + DB Introspection (Best of Both)

At compile time, query ClickHouse for the distinct `location_of` values and generate dimensions dynamically. Recompiles per tenant via `context_to_app_id`.

**Pros:** Automatic, no hardcoded values, supports pre-aggregations.
**Cons:** Requires compile-time DB access (which Synmetrix already has via the smart-gen pipeline).

---

## 6. Implementation Implications for Smart-Gen

To support Approach A or C, the smart-gen pipeline needs to:

1. **Recognize the lookup pattern** — detect that `location_of` (or the first string sub-column with low cardinality) serves as the lookup key for the group
2. **Use LC values as expansion keys** — for each value in `location_of.lcValues` (e.g., `['Vehicle', 'Origin', 'Destination']`), generate dimensions for every other sub-column in the group
3. **Generate arrayElement SQL** — `arrayElement(\`location.label\`, indexOf(\`location.location_of\`, 'Vehicle'))`
4. **Name the dimensions** — `location_vehicle_label`, `location_origin_latitude`, etc.
5. **Set correct types** — latitude/longitude as `number` dimensions, labels as `string`, timestamps as `time`

**Naming convention options:**
- `location_vehicle_label` — flat, Cube.js compatible
- Conceptually maps to `location.Vehicle.label` or `location('Vehicle').label`

**Detection heuristic for the lookup key:**
- First sub-column in the group with `valueType === STRING` and low cardinality (< 60 unique values)
- OR a sub-column explicitly named `*_of`, `*_type`, `*_kind`, `*_category`
- The lookup key's LC values become the expansion set

**Scale concern:** 8 location_of values x 18 other sub-columns = 144 dimensions from one group. With multiple nested groups this could explode. May need a configurable max or allow the user to select which groups to expand.

---

## 7. Open Questions

1. Should all nested groups be expanded this way, or only those where a lookup key is detected?
2. What naming convention? `{parent}_{keyValue}_{child}` or `{parent}_{child}_{keyValue}`?
3. Should the unexpanded array dimensions (current behavior) be kept alongside the expanded ones?
4. How to handle the scale — 8 keys x 18 fields = 144 dimensions per group?
5. Should this be opt-in (configured per group) or automatic (heuristic-based)?
6. For Approach C (asyncModule), how does this integrate with the existing smart-gen YAML output? Smart-gen currently produces YAML, but asyncModule requires JS.

---

## Sources

- [Cube.js Context Variables (FILTER_PARAMS, SECURITY_CONTEXT, SQL_UTILS)](https://cube.dev/docs/product/data-modeling/reference/context-variables)
- [Cube.js Passing Dynamic Parameters Recipe](https://cube.dev/docs/product/data-modeling/recipes/passing-dynamic-parameters-in-a-query)
- [Cube.js Dynamic Data Models](https://cube.dev/docs/product/data-modeling/dynamic)
- [Cube.js JavaScript Data Modeling](https://cube.dev/docs/product/data-modeling/dynamic/javascript)
- [Cube.js YAML + Jinja + Python](https://cube.dev/docs/product/data-modeling/dynamic/jinja)
- [Cube.js Subquery Dimensions](https://cube.dev/docs/product/data-modeling/concepts/subquery-dimensions)
- [Cube.js Dimensions Reference](https://cube.dev/docs/product/data-modeling/reference/dimensions)
- [Cube.js Pre-aggregations Reference](https://cube.dev/docs/product/data-modeling/reference/pre-aggregations)
- [Cube.js Entity-Attribute-Value Recipe](https://cube.dev/docs/product/data-modeling/recipes/entity-attribute-value)
- [GitHub Issue #10048: ClickHouse Array Filtering](https://github.com/cube-js/cube/issues/10048)
- [GitHub Issue #262: FILTER_PARAMS with Pre-Aggregations](https://github.com/cube-js/cube/issues/262)
