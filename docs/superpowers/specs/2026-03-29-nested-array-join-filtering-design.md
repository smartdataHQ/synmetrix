# Nested Array Join Filtering for Smart Model Generator

**Date:** 2026-03-29
**Status:** Approved

## Problem

The smart model generator can `LEFT ARRAY JOIN` nested structures (e.g., `commerce.products` in `cst.semantic_events`) but treats the entire array as one blob. Users need the ability to:

1. Select which nested structures to array join
2. Filter by discriminator columns (e.g., `entry_type = 'Line Item'`) so profiling and the generated cube reflect only matching rows
3. Get auto-derived cube names that reflect the filter context

## Design

### Flow Changes

Current steps: `select` -> `profiling` -> `preview` -> `previewing_changes` -> `change_preview` -> `applying` -> `done`

New steps: `select` -> **`nested_config`** (conditional) -> `profiling` -> `preview` -> `previewing_changes` -> `change_preview` -> `applying` -> `done`

The `nested_config` step only appears when the selected table has nested structures (GROUPED columns with dotted names like `commerce.products.*`).

### Backend

#### New Route: `/api/v1/discover-nested`

**Location:** `services/cubejs/src/routes/discoverNested.js`

**Request:**
```json
{
  "table": "semantic_events",
  "schema": "cst"
}
```

**Logic:**
1. Query `system.columns` for the table to find all columns
2. Identify GROUPED column patterns (dotted names sharing a parent prefix)
3. For each group, detect discriminator columns using `LOOKUP_KEY_PATTERN` (`_of`, `_type`, `_kind`, `_category` suffixes), falling back to first LowCardinality string sub-column
4. Run `SELECT DISTINCT <discriminator> FROM <schema>.<table> ARRAY JOIN <parent>.<child> AS <child> LIMIT 100` for each discriminator
5. Return grouped results

**Response:**
```json
{
  "groups": [
    {
      "name": "commerce.products",
      "columnCount": 76,
      "discriminators": [
        {
          "column": "commerce.products.entry_type",
          "childName": "entry_type",
          "values": ["Line Item", "Cart Item", "Wishlist", "Return Item"]
        }
      ]
    },
    {
      "name": "involves",
      "columnCount": 7,
      "discriminators": [
        {
          "column": "involves.role",
          "childName": "role",
          "values": ["Supplier", "Buyer", "Agent"]
        }
      ]
    }
  ]
}
```

**Auth:** Same pattern as `profileTable` — JWT via `checkAuth`, datasource resolved from headers.

**Registration:** Mount in `services/cubejs/src/index.js` alongside existing routes.

#### Changes to `smartGenerate.js`

Accept a new `nestedFilters` parameter alongside existing `arrayJoinColumns`:

```json
{
  "nestedFilters": [
    {
      "group": "commerce.products",
      "filters": [
        { "column": "entry_type", "values": ["Line Item", "Cart Item"] }
      ]
    }
  ]
}
```

- Convert `nestedFilters` into the existing `arrayJoinColumns` format for `buildCubes()`, plus pass filters through for SQL generation
- Auto-derive cube name from table name + filter values when no explicit override is given (e.g., `semantic_events_line_items_cart_items`)
- Pass nested filters to the profiler so profiling runs against the filtered array-joined result set

#### Changes to `cubeBuilder.js`

Enhance `buildArrayJoinCube()`:
- Accept nested filter descriptors
- Generate cube SQL with `WHERE` clause on discriminator columns:
  ```sql
  SELECT *, commerce.products.entry_type AS entry_type, ...
  FROM cst.semantic_events
  LEFT ARRAY JOIN commerce.products
  WHERE commerce.products.entry_type IN ('Line Item', 'Cart Item')
  ```
- Use filter values to derive cube name suffix via `sanitizeCubeName()`

#### Changes to `profiler.js`

When nested filters are provided, wrap the profiling queries with the array join + WHERE context so column statistics reflect only the filtered expanded rows.

### Frontend

#### New State

```typescript
interface NestedGroup {
  name: string;              // "commerce.products"
  columnCount: number;       // 76
  selected: boolean;         // true = array join this group
  discriminators: {
    column: string;          // "commerce.products.entry_type"
    childName: string;       // "entry_type"
    values: string[];        // all distinct values from ClickHouse
    selectedValues: string[];// user's selected filter values
  }[];
}
```

Add `"nested_config"` to `SmartGenStep` union.

Add state: `nestedGroups: NestedGroup[]`, `derivedCubeName: string`.

#### Discovery Call

On `handleTableSelect`, fire `POST /api/v1/discover-nested` with the selected table/schema. If groups are returned, populate `nestedGroups` state and transition to `nested_config`. If no groups, stay on `select`.

#### `nested_config` Step UI

- Header: "Nested Structures Detected" + count
- Ant Design `Collapse` component, one panel per group:
  - **Collapsed:** group name + column count badge
  - **Expanded:** discriminator columns, each with `Checkbox.Group` of distinct values
- Expanding a card sets `selected: true` on that group
- Live-updating cube name preview below the cards
- Footer: "Skip -- no array joins" text link + "Continue" primary button

#### Removal of Existing Array Join UI

The array join checkbox section in the `preview` step (current lines 1447-1495) is removed. Array join configuration moves entirely to `nested_config`.

#### Wiring to Smart Gen Mutation

`handlePreviewChanges` and `handleApply` pass the new `nestedFilters` derived from `nestedGroups` state to the GraphQL mutation, alongside the existing parameters.

### Cube Name Derivation

Auto-derived from: `{table_name}_{filter_value_1}_{filter_value_2}` with sanitization.

Examples:
- `semantic_events` + `entry_type IN ('Line Item')` -> `semantic_events_line_items`
- `semantic_events` + `entry_type IN ('Line Item', 'Cart Item')` -> `semantic_events_line_items_cart_items`
- `semantic_events` + `entry_type IN ('Line Item')` + `role IN ('Supplier')` -> `semantic_events_line_items_suppliers`

User can override this later in the existing file/cube name fields.

### GraphQL / Hasura Action Changes

The `smart_gen_dataschemas` action in `actions.yaml` needs:
- New input field `nested_filters` of type `[NestedFilterInput]` (or reuse `FilterConditionInput` if shape matches)
- `NestedFilterInput`: `{ group: String!, filters: [NestedFilterCondition!]! }`
- `NestedFilterCondition`: `{ column: String!, values: [String!]! }`

This flows through the RPC handler `smartGenSchemas.js` which passes it to the CubeJS `/api/v1/smart-generate` route.

### What's NOT Changing

- The existing filter builder (partition filters, date ranges, etc.) stays in the `select` step
- The profiling SSE flow is unchanged (just receives additional context)
- The change preview, AI enrichment, merge strategy, and apply flows are unchanged
- Column selection in the `preview` step remains
