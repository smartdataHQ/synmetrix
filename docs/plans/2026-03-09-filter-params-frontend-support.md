# FILTER_PARAMS Frontend Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add smart, dynamic discovery and management of FILTER_PARAMS-based dimensions in the Explore UI, so that when a user selects a dimension that depends on a lookup key (e.g. `location_label` which needs `location_type`), the UI automatically surfaces the required parameter filter with a dropdown of known values.

**Architecture:** The Cube.js metadata API already passes through custom `meta` properties from data models. We read `meta.nested_lookup_key`, `meta.known_values`, and `meta.resolved_by` from the dimension metadata to (1) detect which dimensions require a parameter, (2) auto-inject the required filter with a known-values dropdown, and (3) visually distinguish parameterized dimensions in the sidebar. All logic is derived from metadata — no hardcoding of field names.

**Tech Stack:** React 18, TypeScript, Ant Design 5, Zustand/useReducer (existing patterns), URQL (existing GraphQL client), Vitest (testing)

---

## Background: What FILTER_PARAMS Dimensions Look Like

The smart-gen pipeline produces JS models where nested/grouped ClickHouse columns use `FILTER_PARAMS` for query-time resolution. The Cube.js metadata API exposes custom `meta` on each dimension. Here are the three relevant meta shapes:

### 1. Lookup Key Dimension (the "parameter")
```javascript
classification_type: {
  sql: `toString(${FILTER_PARAMS.semantic_events.classification_type.filter((v) => v)})`,
  type: 'string',
  meta: {
    nested_lookup_key: true,         // <-- THIS marks it as a parameter
    known_values: ["Category", "Tag"], // <-- Dropdown options
    source_column: "classification.type",
    auto_generated: true,
  },
}
```

### 2. Resolved Dimension (depends on the parameter)
```javascript
classification_value: {
  sql: `arrayElementOrNull(...)`,
  type: 'string',
  meta: {
    resolved_by: "classification_type", // <-- Points to the lookup key
    source_column: "classification.value",
    auto_generated: true,
  },
}
```

### 3. Normal Dimension (no FILTER_PARAMS involvement)
```javascript
event: {
  sql: `${CUBE}.event`,
  type: 'string',
  meta: {
    source_column: "event",
    auto_generated: true,
  },
}
```

## Data Flow Through the System

```
JS Model (meta on dimensions)
  → Cube.js Schema Compiler (CubeToMetaTransformer preserves meta)
    → /api/v1/meta endpoint (meta included in response)
      → Hasura Action fetch_meta → Actions service cubejsApi.meta()
        → Frontend useFetchMetaQuery → useDataSourcesMeta
          → CubeMember objects with meta property
```

The `CubeMember` type already has `meta?: any` — the metadata is already flowing to the frontend. We just need to read it.

## Codebase Conventions (for the implementing engineer)

- **Imports**: The codebase uses auto-imports from React (e.g. `useMemo`, `useState` appear without explicit import in some files). However, always add explicit imports to be safe.
- **i18n**: All user-facing strings go through `react-i18next`. Use `t()` function. Translation keys follow `common:words.xxx` or `common:operators.xxx` patterns.
- **State**: `unchanged` library is used for immutable operations (`set`, `remove`, `getOr`).
- **Custom Button**: The app uses `@/components/Button` (not Ant Design's Button directly) in `ExploreDataSection`.
- **Testing**: Vitest with `@testing-library/react` for hook tests.

---

## Task 1: Add Helper Utility — `filterParamsResolver`

This utility extracts FILTER_PARAMS dependency information from cube metadata and provides methods for the UI to discover required parameters.

**Files:**
- Create: `../client-v2/src/utils/helpers/filterParamsResolver.ts`
- Create: `../client-v2/src/utils/helpers/__tests__/filterParamsResolver.test.ts`

### Step 1: Write the failing tests

```typescript
// ../client-v2/src/utils/helpers/__tests__/filterParamsResolver.test.ts
import { describe, it, expect } from 'vitest';
import {
  isLookupKeyDimension,
  isResolvedDimension,
  getKnownValues,
  getRequiredFilterParams,
  deduplicateFilterParams,
} from '../filterParamsResolver';

import type { CubeMember } from '@/types/cube';

function makeMember(overrides: Partial<CubeMember> = {}): CubeMember {
  return {
    name: 'semantic_events.event',
    title: 'Semantic Events Event',
    shortTitle: 'Event',
    isVisible: true,
    type: 'string',
    ...overrides,
  };
}

describe('filterParamsResolver', () => {
  describe('isLookupKeyDimension', () => {
    it('returns true for dimensions with nested_lookup_key meta', () => {
      const member = makeMember({
        name: 'semantic_events.classification_type',
        meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
      });
      expect(isLookupKeyDimension(member)).toBe(true);
    });

    it('returns false for normal dimensions', () => {
      const member = makeMember({ meta: { auto_generated: true } });
      expect(isLookupKeyDimension(member)).toBe(false);
    });

    it('returns false when meta is undefined', () => {
      const member = makeMember({ meta: undefined });
      expect(isLookupKeyDimension(member)).toBe(false);
    });
  });

  describe('isResolvedDimension', () => {
    it('returns true for dimensions with resolved_by meta', () => {
      const member = makeMember({
        name: 'semantic_events.classification_value',
        meta: { resolved_by: 'classification_type' },
      });
      expect(isResolvedDimension(member)).toBe(true);
    });

    it('returns false for normal dimensions', () => {
      const member = makeMember({ meta: {} });
      expect(isResolvedDimension(member)).toBe(false);
    });
  });

  describe('getKnownValues', () => {
    it('returns known_values array for lookup key dimensions', () => {
      const member = makeMember({
        meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
      });
      expect(getKnownValues(member)).toEqual(['Category', 'Tag']);
    });

    it('returns empty array for non-lookup dimensions', () => {
      const member = makeMember({ meta: {} });
      expect(getKnownValues(member)).toEqual([]);
    });

    it('returns empty array when known_values is missing', () => {
      const member = makeMember({ meta: { nested_lookup_key: true } });
      expect(getKnownValues(member)).toEqual([]);
    });
  });

  describe('getRequiredFilterParams', () => {
    it('returns empty array when no selected dimensions need params', () => {
      const selected = ['semantic_events.event', 'semantic_events.type'];
      const available: Record<string, CubeMember> = {
        'semantic_events.event': makeMember({ name: 'semantic_events.event' }),
        'semantic_events.type': makeMember({ name: 'semantic_events.type' }),
      };
      expect(getRequiredFilterParams(selected, available)).toEqual([]);
    });

    it('returns lookup key when a resolved dimension is selected', () => {
      const selected = ['semantic_events.classification_value'];
      const available: Record<string, CubeMember> = {
        'semantic_events.classification_type': makeMember({
          name: 'semantic_events.classification_type',
          meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
        }),
        'semantic_events.classification_value': makeMember({
          name: 'semantic_events.classification_value',
          meta: { resolved_by: 'classification_type' },
        }),
      };
      const result = getRequiredFilterParams(selected, available);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('semantic_events.classification_type');
      expect(result[0].meta.known_values).toEqual(['Category', 'Tag']);
    });

    it('returns lookup key only once even when multiple resolved dims share it', () => {
      const selected = [
        'semantic_events.classification_value',
        'semantic_events.classification_reasoning',
      ];
      const available: Record<string, CubeMember> = {
        'semantic_events.classification_type': makeMember({
          name: 'semantic_events.classification_type',
          meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
        }),
        'semantic_events.classification_value': makeMember({
          name: 'semantic_events.classification_value',
          meta: { resolved_by: 'classification_type' },
        }),
        'semantic_events.classification_reasoning': makeMember({
          name: 'semantic_events.classification_reasoning',
          meta: { resolved_by: 'classification_type' },
        }),
      };
      const result = getRequiredFilterParams(selected, available);
      expect(result).toHaveLength(1);
    });

    it('returns multiple lookup keys when dims from different groups are selected', () => {
      const selected = [
        'semantic_events.classification_value',
        'semantic_events.location_label',
      ];
      const available: Record<string, CubeMember> = {
        'semantic_events.classification_type': makeMember({
          name: 'semantic_events.classification_type',
          meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
        }),
        'semantic_events.classification_value': makeMember({
          name: 'semantic_events.classification_value',
          meta: { resolved_by: 'classification_type' },
        }),
        'semantic_events.location_type': makeMember({
          name: 'semantic_events.location_type',
          meta: { nested_lookup_key: true, known_values: ['Vehicle', 'Origin'] },
        }),
        'semantic_events.location_label': makeMember({
          name: 'semantic_events.location_label',
          meta: { resolved_by: 'location_type' },
        }),
      };
      const result = getRequiredFilterParams(selected, available);
      expect(result).toHaveLength(2);
      const names = result.map((r) => r.name);
      expect(names).toContain('semantic_events.classification_type');
      expect(names).toContain('semantic_events.location_type');
    });

    it('still returns lookup key when it is already in the selected list', () => {
      const selected = [
        'semantic_events.classification_type',
        'semantic_events.classification_value',
      ];
      const available: Record<string, CubeMember> = {
        'semantic_events.classification_type': makeMember({
          name: 'semantic_events.classification_type',
          meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
        }),
        'semantic_events.classification_value': makeMember({
          name: 'semantic_events.classification_value',
          meta: { resolved_by: 'classification_type' },
        }),
      };
      const result = getRequiredFilterParams(selected, available);
      expect(result).toHaveLength(1);
    });
  });

  describe('deduplicateFilterParams', () => {
    it('removes duplicate filter param entries by name', () => {
      const params = [
        makeMember({ name: 'semantic_events.classification_type' }),
        makeMember({ name: 'semantic_events.classification_type' }),
        makeMember({ name: 'semantic_events.location_type' }),
      ];
      const result = deduplicateFilterParams(params);
      expect(result).toHaveLength(2);
    });

    it('returns empty array for empty input', () => {
      expect(deduplicateFilterParams([])).toEqual([]);
    });
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ../client-v2 && npx vitest run src/utils/helpers/__tests__/filterParamsResolver.test.ts`
Expected: FAIL — module not found

### Step 3: Write the implementation

```typescript
// ../client-v2/src/utils/helpers/filterParamsResolver.ts
import type { CubeMember } from '@/types/cube';

/**
 * Check if a dimension is a lookup key (FILTER_PARAMS parameter).
 * These are the "selector" dimensions like classification_type, location_type.
 */
export function isLookupKeyDimension(member: CubeMember): boolean {
  return member?.meta?.nested_lookup_key === true;
}

/**
 * Check if a dimension depends on a lookup key.
 * These are the "data" dimensions like classification_value, location_label.
 */
export function isResolvedDimension(member: CubeMember): boolean {
  return typeof member?.meta?.resolved_by === 'string' && member.meta.resolved_by.length > 0;
}

/**
 * Get the known values for a lookup key dimension.
 */
export function getKnownValues(member: CubeMember): string[] {
  if (!isLookupKeyDimension(member)) return [];
  return Array.isArray(member.meta?.known_values) ? member.meta.known_values : [];
}

/**
 * Given a list of selected dimension names and a map of all available dimensions,
 * return the list of lookup key CubeMembers that are required as filter parameters.
 *
 * Scans selected dimensions for any with `meta.resolved_by`, then finds the
 * corresponding lookup key dimension in the same cube. Deduplicates automatically.
 *
 * @param selectedDimensionNames - Array of fully-qualified names (e.g. "semantic_events.classification_value")
 * @param availableDimensions - Map of all available dimensions keyed by name
 * @returns Array of unique lookup key CubeMembers that need filter values
 */
export function getRequiredFilterParams(
  selectedDimensionNames: string[],
  availableDimensions: Record<string, CubeMember>,
): CubeMember[] {
  const requiredKeys = new Map<string, CubeMember>();

  for (const dimName of selectedDimensionNames) {
    const member = availableDimensions[dimName];
    if (!member || !isResolvedDimension(member)) continue;

    // resolved_by is the short name (e.g. "classification_type")
    // We need the fully-qualified name: "CubeName.classification_type"
    const [cubeName] = dimName.split('.');
    const lookupKeyName = `${cubeName}.${member.meta.resolved_by}`;
    const lookupMember = availableDimensions[lookupKeyName];

    if (lookupMember && !requiredKeys.has(lookupKeyName)) {
      requiredKeys.set(lookupKeyName, lookupMember);
    }
  }

  return Array.from(requiredKeys.values());
}

/**
 * Remove duplicate filter param entries by name.
 */
export function deduplicateFilterParams(params: CubeMember[]): CubeMember[] {
  const seen = new Set<string>();
  return params.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}
```

### Step 4: Run tests to verify they pass

Run: `cd ../client-v2 && npx vitest run src/utils/helpers/__tests__/filterParamsResolver.test.ts`
Expected: PASS — all tests green

### Step 5: Commit

```bash
cd ../client-v2
git add src/utils/helpers/filterParamsResolver.ts src/utils/helpers/__tests__/filterParamsResolver.test.ts
git commit -m "feat: add filterParamsResolver utility for FILTER_PARAMS discovery"
```

---

## Task 2: Add `useFilterParams` Hook — Reactive Discovery

This hook watches selected dimensions and automatically computes which FILTER_PARAMS are required. It uses a stable JSON key to avoid unnecessary re-renders.

**Files:**
- Create: `../client-v2/src/hooks/useFilterParams.ts`
- Create: `../client-v2/src/hooks/__tests__/useFilterParams.test.ts`

### Step 1: Write the failing tests

```typescript
// ../client-v2/src/hooks/__tests__/useFilterParams.test.ts
import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import useFilterParams from '../useFilterParams';
import type { CubeMember } from '@/types/cube';

function makeMember(overrides: Partial<CubeMember> = {}): CubeMember {
  return {
    name: 'test.field',
    title: 'Test Field',
    shortTitle: 'Field',
    isVisible: true,
    type: 'string',
    ...overrides,
  };
}

const emptyPlayground = {
  dimensions: [] as string[],
  measures: [] as string[],
  filters: [] as any[],
  timeDimensions: [] as any[],
  segments: [] as string[],
  order: [] as any[],
  timezone: 'UTC',
  limit: 100,
  offset: 0,
};

describe('useFilterParams', () => {
  it('returns empty requiredParams when no dimensions need params', () => {
    const availableQueryMembers = {
      semantic_events: {
        dimensions: {
          'semantic_events.event': makeMember({ name: 'semantic_events.event' }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: { ...emptyPlayground, dimensions: ['semantic_events.event'] },
      })
    );

    expect(result.current.requiredParams).toEqual([]);
    expect(result.current.missingParams).toEqual([]);
  });

  it('returns required params when resolved dimensions are selected', () => {
    const availableQueryMembers = {
      semantic_events: {
        dimensions: {
          'semantic_events.classification_type': makeMember({
            name: 'semantic_events.classification_type',
            meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
          }),
          'semantic_events.classification_value': makeMember({
            name: 'semantic_events.classification_value',
            meta: { resolved_by: 'classification_type' },
          }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: {
          ...emptyPlayground,
          dimensions: ['semantic_events.classification_value'],
        },
      })
    );

    expect(result.current.requiredParams).toHaveLength(1);
    expect(result.current.requiredParams[0].name).toBe('semantic_events.classification_type');
  });

  it('reports missing params when required filter is not in filters list', () => {
    const availableQueryMembers = {
      semantic_events: {
        dimensions: {
          'semantic_events.classification_type': makeMember({
            name: 'semantic_events.classification_type',
            meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
          }),
          'semantic_events.classification_value': makeMember({
            name: 'semantic_events.classification_value',
            meta: { resolved_by: 'classification_type' },
          }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: {
          ...emptyPlayground,
          dimensions: ['semantic_events.classification_value'],
          filters: [],
        },
      })
    );

    expect(result.current.missingParams).toHaveLength(1);
    expect(result.current.missingParams[0].name).toBe('semantic_events.classification_type');
  });

  it('reports no missing params when filter is already set', () => {
    const availableQueryMembers = {
      semantic_events: {
        dimensions: {
          'semantic_events.classification_type': makeMember({
            name: 'semantic_events.classification_type',
            meta: { nested_lookup_key: true, known_values: ['Category', 'Tag'] },
          }),
          'semantic_events.classification_value': makeMember({
            name: 'semantic_events.classification_value',
            meta: { resolved_by: 'classification_type' },
          }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: {
          ...emptyPlayground,
          dimensions: ['semantic_events.classification_value'],
          filters: [
            { dimension: 'semantic_events.classification_type', operator: 'equals', values: ['Category'] },
          ],
        },
      })
    );

    expect(result.current.missingParams).toEqual([]);
    expect(result.current.requiredParams).toHaveLength(1);
  });

  it('handles empty playground state', () => {
    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers: {},
        playgroundState: emptyPlayground,
      })
    );

    expect(result.current.requiredParams).toEqual([]);
    expect(result.current.missingParams).toEqual([]);
  });

  it('handles cubes with no FILTER_PARAMS dimensions', () => {
    const availableQueryMembers = {
      orders: {
        dimensions: {
          'orders.id': makeMember({ name: 'orders.id', meta: {} }),
          'orders.status': makeMember({ name: 'orders.status', meta: {} }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: { ...emptyPlayground, dimensions: ['orders.id', 'orders.status'] },
      })
    );

    expect(result.current.requiredParams).toEqual([]);
    expect(result.current.missingParams).toEqual([]);
  });

  it('handles multiple cubes with mixed FILTER_PARAMS and normal dimensions', () => {
    const availableQueryMembers = {
      orders: {
        dimensions: {
          'orders.id': makeMember({ name: 'orders.id' }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
      semantic_events: {
        dimensions: {
          'semantic_events.classification_type': makeMember({
            name: 'semantic_events.classification_type',
            meta: { nested_lookup_key: true, known_values: ['Category'] },
          }),
          'semantic_events.classification_value': makeMember({
            name: 'semantic_events.classification_value',
            meta: { resolved_by: 'classification_type' },
          }),
        },
        measures: {},
        segments: {},
        timeDimensions: {},
      },
    };

    const { result } = renderHook(() =>
      useFilterParams({
        availableQueryMembers,
        playgroundState: {
          ...emptyPlayground,
          dimensions: ['orders.id', 'semantic_events.classification_value'],
        },
      })
    );

    expect(result.current.requiredParams).toHaveLength(1);
    expect(result.current.requiredParams[0].name).toBe('semantic_events.classification_type');
  });
});
```

### Step 2: Run tests to verify they fail

Run: `cd ../client-v2 && npx vitest run src/hooks/__tests__/useFilterParams.test.ts`
Expected: FAIL — module not found

### Step 3: Write the implementation

```typescript
// ../client-v2/src/hooks/useFilterParams.ts
import { useMemo, useRef } from 'react';
import { getOr } from 'unchanged';

import {
  getRequiredFilterParams,
  deduplicateFilterParams,
} from '@/utils/helpers/filterParamsResolver';
import type { CubeMember } from '@/types/cube';
import type { PlaygroundState } from '@/types/exploration';

interface Props {
  availableQueryMembers: Record<string, Record<string, Record<string, CubeMember>>>;
  playgroundState: PlaygroundState;
}

interface FilterParamsResult {
  /** All FILTER_PARAMS lookup keys required by currently selected dimensions */
  requiredParams: CubeMember[];
  /** Subset of requiredParams that don't have a corresponding filter yet */
  missingParams: CubeMember[];
}

/**
 * Watches the current playground state and available cube metadata to determine
 * which FILTER_PARAMS dimensions are required based on the selected dimensions.
 *
 * Uses a stable JSON key to prevent unnecessary re-renders when the computed
 * result hasn't actually changed.
 */
export default function useFilterParams({ availableQueryMembers, playgroundState }: Props): FilterParamsResult {
  const prevKeyRef = useRef<string>('');
  const prevResultRef = useRef<FilterParamsResult>({ requiredParams: [], missingParams: [] });

  return useMemo(() => {
    if (!availableQueryMembers || !playgroundState) {
      return { requiredParams: [], missingParams: [] };
    }

    // Flatten all available dimensions across all cubes
    const allDimensions: Record<string, CubeMember> = {};
    for (const cubeName of Object.keys(availableQueryMembers)) {
      const cubeDims = getOr({}, 'dimensions', availableQueryMembers[cubeName]) as Record<string, CubeMember>;
      Object.assign(allDimensions, cubeDims);
    }

    // Get selected dimension names from playground state
    const selectedDims: string[] = getOr([], 'dimensions', playgroundState);

    // Find required filter params
    const requiredParams = deduplicateFilterParams(
      getRequiredFilterParams(selectedDims, allDimensions)
    );

    // Check which required params already have a filter set
    const existingFilterDims = new Set(
      getOr([], 'filters', playgroundState).map((f: any) => f.dimension)
    );

    const missingParams = requiredParams.filter(
      (p) => !existingFilterDims.has(p.name)
    );

    // Stable reference check: only return new object if the result changed
    const key = JSON.stringify({
      req: requiredParams.map((p) => p.name),
      miss: missingParams.map((p) => p.name),
    });

    if (key === prevKeyRef.current) {
      return prevResultRef.current;
    }

    prevKeyRef.current = key;
    prevResultRef.current = { requiredParams, missingParams };
    return prevResultRef.current;
  }, [availableQueryMembers, playgroundState]);
}
```

**Why the stable reference?** Without the `prevKeyRef` / `prevResultRef` pattern, `useMemo` returns a new `{ requiredParams: [], missingParams: [] }` object on every `playgroundState` change — even when the actual result hasn't changed. This would cause `useEffect` consumers (like the auto-inject in Task 4) to fire unnecessarily. The JSON key comparison ensures the returned object reference is stable when the logical content is unchanged.

### Step 4: Run tests to verify they pass

Run: `cd ../client-v2 && npx vitest run src/hooks/__tests__/useFilterParams.test.ts`
Expected: PASS

### Step 5: Commit

```bash
cd ../client-v2
git add src/hooks/useFilterParams.ts src/hooks/__tests__/useFilterParams.test.ts
git commit -m "feat: add useFilterParams hook for reactive FILTER_PARAMS discovery"
```

---

## Task 3: Wire `useFilterParams` into `usePlayground` and Expose to Workspace

Connect the hook into the existing data flow so components can access filter param info.

**Files:**
- Modify: `../client-v2/src/hooks/usePlayground.ts`
- Modify: `../client-v2/src/components/ExploreWorkspace/index.tsx`

### Step 1: Modify `usePlayground.ts`

In `../client-v2/src/hooks/usePlayground.ts`:

**Add import** (after existing imports, ~line 11):

```typescript
import useFilterParams from '@/hooks/useFilterParams';
```

**Call the hook** (after the `useDataSourceMeta` call, ~line 120-123):

```typescript
  const { requiredParams, missingParams } = useFilterParams({
    availableQueryMembers: availableQueryMembers || {},
    playgroundState: currPlaygroundState,
  });
```

**Add to return object** (inside the return statement, ~line 189-205, after `dispatchSettings`):

```typescript
    filterParams: { requiredParams, missingParams },
```

### Step 2: Modify `ExploreWorkspace/index.tsx`

In `../client-v2/src/components/ExploreWorkspace/index.tsx`:

**Destructure `filterParams`** from `usePlayground` (~line 73-92). Add after `dispatchSettings`:

```typescript
    filterParams,
```

**Update `showFiltersSection`** (~line 191-192). Replace:

```typescript
  const showFiltersSection =
    !!state.filtersCount && state.dataSection === "results";
```

With:

```typescript
  const showFiltersSection =
    (!!state.filtersCount || (filterParams?.missingParams?.length ?? 0) > 0) &&
    state.dataSection === "results";
```

**Pass `filterParams` to `ExploreFiltersSection`** (~line 216-224). Add the prop:

```tsx
              filterParams={filterParams}
```

### Step 3: Verify the app still compiles

Run: `cd ../client-v2 && npx tsc --noEmit 2>&1 | head -20`
Expected: No new type errors (pre-existing errors may remain)

### Step 4: Commit

```bash
cd ../client-v2
git add src/hooks/usePlayground.ts src/components/ExploreWorkspace/index.tsx
git commit -m "feat: wire useFilterParams into usePlayground and ExploreWorkspace"
```

---

## Task 4: Auto-Inject Required Filter Parameters

When a user selects a dimension with `resolved_by`, automatically add the lookup key dimension as a filter with `equals` operator and the first known value pre-selected.

**Files:**
- Modify: `../client-v2/src/hooks/usePlayground.ts`

### Step 1: Add auto-inject effect

In `../client-v2/src/hooks/usePlayground.ts`, after the `useFilterParams` call, add a `useEffect`:

```typescript
  // Auto-inject missing FILTER_PARAMS as filters when resolved dimensions are selected
  useEffect(() => {
    if (!missingParams || missingParams.length === 0) return;

    for (const param of missingParams) {
      const knownValues = Array.isArray(param.meta?.known_values) ? param.meta.known_values : [];
      const defaultValue = knownValues.length > 0 ? knownValues[0] : '';

      dispatch({
        type: 'add',
        memberType: 'filters',
        value: {
          dimension: param.name,
          operator: 'equals',
          values: defaultValue ? [defaultValue] : [],
        },
        operatorType: 'string',
      });
    }
  }, [missingParams, dispatch]);
```

**Note:** `dispatch` is already available from `useAnalyticsQuery()` — verify it's destructured (~line 109-118):

```typescript
  const {
    state: currPlaygroundState,
    dispatch,              // <-- Must be here
    updateMember,
    // ...
  } = useAnalyticsQuery();
```

It IS already destructured on ~line 111.

**Why this won't infinite-loop:** The `missingParams` reference is stabilized by `useFilterParams` (Task 2's `prevKeyRef` pattern). When the effect dispatches filter additions, `playgroundState` changes → `useFilterParams` recomputes → `missingParams` becomes `[]` → but the JSON key changes so a new reference is returned → the effect fires again but the guard `if (missingParams.length === 0) return` exits immediately. On the next render, `missingParams` is still `[]` with the same key → stable reference → effect doesn't fire again.

### Step 2: Test manually

1. Start the dev server: `cd ../client-v2 && yarn dev`
2. Navigate to the Explore page for a datasource with smart-generated models
3. Select a resolved dimension (e.g. `classification_value`)
4. Verify that a filter for `classification_type` automatically appears with `equals` operator and first known value (`Category`)

### Step 3: Commit

```bash
cd ../client-v2
git add src/hooks/usePlayground.ts
git commit -m "feat: auto-inject required FILTER_PARAMS filters when resolved dimensions are selected"
```

---

## Task 5: Known Values Dropdown in Filter Input

Replace the free-text `Select` (tags mode) with a dropdown of known values when the filter dimension has `meta.known_values`.

**Files:**
- Modify: `../client-v2/src/components/PlaygroundFilterInput/index.tsx`

### Step 1: Read the file to confirm current structure

Read: `../client-v2/src/components/PlaygroundFilterInput/index.tsx`

Confirm: The `FilterInput` component starts at ~line 97. It uses `member?.dimension?.type` to pick a filter input. We need to check `member?.dimension?.meta?.known_values` first.

### Step 2: Modify the FilterInput component

Replace the component body from ~line 97 to ~line 141 with:

```tsx
const FilterInput: FC<FilterInputProps> = ({
  member,
  updateMethods,
  addMemberName,
}) => {
  const [memberValues, setMemberValues] = useState(member.values || []);

  const { run: debouncedUpdate } = useDebounceFn(
    ({ values }) => {
      trackEvent("Update Filter Values", { memberName: addMemberName });
      updateMethods.update(member, { ...member, values });
    },
    { wait: 500 }
  );

  if (
    !member ||
    (member.operator && inputlessOperators.includes(member.operator))
  ) {
    return null;
  }

  // Check for known_values on the resolved dimension (FILTER_PARAMS lookup keys)
  const knownValues: string[] | undefined = member?.dimension?.meta?.known_values;
  const hasKnownValues = Array.isArray(knownValues) && knownValues.length > 0;

  if (hasKnownValues) {
    return (
      <Select
        size="large"
        key="known-values-filter"
        style={{ width: 300 }}
        mode="multiple"
        onChange={(values: string[]) => {
          setMemberValues(values);
          debouncedUpdate({ values });
        }}
        value={memberValues}
        placeholder="Select a value"
      >
        {knownValues.map((val: string) => (
          <Select.Option key={val} value={val}>
            {val}
          </Select.Option>
        ))}
      </Select>
    );
  }

  const dimensionType = member?.dimension?.type || "";
  let Filter =
    filterInputs[dimensionType as keyof typeof filterInputs] ||
    filterInputs.string;

  if (member.operator && rangeOperators.includes(member.operator)) {
    Filter = filterInputs.timeRange;
  }

  return (
    <Filter
      key="filter"
      values={memberValues}
      onChange={(values) => {
        setMemberValues(values);
        debouncedUpdate({ values });
      }}
    />
  );
};
```

The key change is the `hasKnownValues` check that renders a closed dropdown (defined options only) instead of the default `mode="tags"` free-text input.

### Step 3: Test manually

1. Select a resolved dimension in the Explore UI
2. The auto-injected filter should show a dropdown with known values (e.g. "Category", "Tag") instead of a free-text tag input
3. Changing the selected value should update the filter and subsequent query results

### Step 4: Commit

```bash
cd ../client-v2
git add src/components/PlaygroundFilterInput/index.tsx
git commit -m "feat: use known_values dropdown for FILTER_PARAMS filter inputs"
```

---

## Task 6: Visual Indicator for Parameterized Dimensions in Sidebar

Add a visual indicator (tag/badge) on dimensions that require or provide a FILTER_PARAMS parameter.

**Files:**
- Modify: `../client-v2/src/components/ExploreCubesCategoryItem/index.tsx`
- Modify: `../client-v2/src/components/ExploreCubesCategoryItem/index.module.less`

### Step 1: Add imports and indicator logic

In `../client-v2/src/components/ExploreCubesCategoryItem/index.tsx`:

**Add imports** (at top, after existing imports):

```typescript
import { Row, Col, Typography, Tag, Tooltip } from "antd";
import { isLookupKeyDimension, isResolvedDimension } from "@/utils/helpers/filterParamsResolver";
```

**Remove the existing** `import { Row, Col, Typography } from "antd";` line (line 2) since we're replacing it.

### Step 2: Add indicators to the JSX

Inside the `CategoryItem` component, after the `icon` assignment (~line 52-55), add:

```typescript
  const isLookup = isLookupKeyDimension(member);
  const isResolved = isResolvedDimension(member);
```

Then replace the `<div className={s.memberRow}>` block (~line 79-82) with:

```tsx
              <div className={s.memberRow}>
                <div className={s.memberIcon}>{icon}</div>
                <a className={cn(s.member)}>{member.shortTitle}</a>
                {isLookup && (
                  <Tooltip title={`Parameter — values: ${(member.meta?.known_values || []).join(', ')}`}>
                    <Tag color="blue" className={s.paramTag}>P</Tag>
                  </Tooltip>
                )}
                {isResolved && (
                  <Tooltip title={`Requires filter: ${member.meta?.resolved_by}`}>
                    <Tag color="orange" className={s.paramTag}>F</Tag>
                  </Tooltip>
                )}
              </div>
```

### Step 3: Add CSS for the tag

In `../client-v2/src/components/ExploreCubesCategoryItem/index.module.less`, add at the end:

```less
.paramTag {
  font-size: 9px;
  line-height: 14px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 3px;
  cursor: help;
}
```

### Step 4: Test manually

1. Open the Explore sidebar
2. Look for dimensions with blue "P" tag (lookup keys like `classification_type`)
3. Look for dimensions with orange "F" tag (resolved dims like `classification_value`)
4. Hover to see tooltips explaining the relationship

### Step 5: Commit

```bash
cd ../client-v2
git add src/components/ExploreCubesCategoryItem/index.tsx src/components/ExploreCubesCategoryItem/index.module.less
git commit -m "feat: add visual P/F indicators for FILTER_PARAMS dimensions in sidebar"
```

---

## Task 7: Auto-Remove Orphaned Filters on Dimension Deselect

When a user removes all resolved dimensions that depended on a lookup key, automatically remove the auto-injected filter.

**Files:**
- Modify: `../client-v2/src/hooks/usePlayground.ts`

### Step 1: Add imports and cleanup effect

In `../client-v2/src/hooks/usePlayground.ts`:

**Add imports** (at top, if not already present):

```typescript
import { getOr } from 'unchanged';
import type { CubeMember } from '@/types/cube';
import {
  getRequiredFilterParams,
  isLookupKeyDimension,
} from '@/utils/helpers/filterParamsResolver';
```

**Note:** `getOr` may not already be imported in this file — check first. If `unchanged` is not imported, add it.

**Add cleanup effect** after the auto-inject effect from Task 4:

```typescript
  // Auto-remove orphaned FILTER_PARAMS filters when no resolved dimensions need them
  useEffect(() => {
    if (!availableQueryMembers) return;

    const existingFilters: any[] = getOr([], 'filters', currPlaygroundState);
    if (existingFilters.length === 0) return;

    // Flatten all available dimensions
    const allDimensions: Record<string, CubeMember> = {};
    for (const cubeName of Object.keys(availableQueryMembers)) {
      const cubeDims = getOr({}, 'dimensions', availableQueryMembers[cubeName]) as Record<string, CubeMember>;
      Object.assign(allDimensions, cubeDims);
    }

    // Find which lookup keys are still required
    const selectedDims: string[] = getOr([], 'dimensions', currPlaygroundState);
    const stillRequired = new Set(
      getRequiredFilterParams(selectedDims, allDimensions).map((p) => p.name)
    );

    // Find filter indices to remove (iterate in reverse to preserve indices during dispatch)
    const indicesToRemove: number[] = [];
    for (let i = existingFilters.length - 1; i >= 0; i--) {
      const filterDim = existingFilters[i].dimension;
      const member = allDimensions[filterDim];
      // Only auto-remove filters for lookup key dimensions that are no longer needed
      if (member && isLookupKeyDimension(member) && !stillRequired.has(filterDim)) {
        indicesToRemove.push(i);
      }
    }

    for (const idx of indicesToRemove) {
      dispatch({ type: 'remove', memberType: 'filters', index: idx });
    }
    // Depend on dimensions array (stringified for stable reference), NOT full playgroundState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(currPlaygroundState.dimensions), availableQueryMembers, dispatch]);
```

**Why `JSON.stringify(currPlaygroundState.dimensions)` as dependency?** We only want this effect to fire when the *dimensions* list changes (user adds/removes a dimension), not when filters change (which would cause a loop). The `JSON.stringify` creates a stable string comparison.

### Step 2: Test manually

1. Select `classification_value` → filter for `classification_type` auto-appears
2. Remove `classification_value` from selected dimensions
3. Verify `classification_type` filter is automatically removed
4. Verify manually-added filters (on non-lookup-key dimensions) are NOT removed

### Step 3: Commit

```bash
cd ../client-v2
git add src/hooks/usePlayground.ts
git commit -m "feat: auto-remove orphaned FILTER_PARAMS filters when resolved dims are deselected"
```

---

## Task 8: Warning Banner for Missing Parameters

Show an inline warning when required FILTER_PARAMS dimensions don't have filter values set.

**Files:**
- Modify: `../client-v2/src/components/ExploreFiltersSection/index.tsx`

### Step 1: Update imports and props interface

In `../client-v2/src/components/ExploreFiltersSection/index.tsx`:

**Update Ant Design import** (line 1):

```typescript
import { Space, Badge, Button, Collapse, Alert, type CollapsePanelProps } from "antd";
```

**Add `useMemo` import** — this file already uses `useMemo` on line 53 but does NOT explicitly import it. Add it:

```typescript
import { useMemo } from "react";
```

**Update props interface** (~line 13-31). Add `filterParams` prop:

```typescript
interface ExploreFiltersSectionProps
  extends Omit<CollapsePanelProps, "header"> {
  onToggleSection: (section: string) => void;
  selectedQueryMembers: Record<string, (CubeMember | CubeMember)[]>;
  onMemberChange: (
    memberType: string,
    cb?: (member: CubeMember) => any
  ) => {
    add: (member: CubeMember) => void;
    remove: (member: CubeMember) => void;
    update: (member: CubeMember, newValue: any) => void;
  };
  availableQueryMembers: Record<
    string,
    Record<string, Record<string, CubeMember>>
  >;
  state: ExploreWorkspaceState;
  isActive?: boolean;
  filterParams?: {
    requiredParams: CubeMember[];
    missingParams: CubeMember[];
  };
}
```

### Step 2: Add warning banner

**Destructure `filterParams`** in the component (~line 43-51):

```typescript
    filterParams,
```

**Compute missing names** after destructuring:

```typescript
  const missingNames = filterParams?.missingParams?.map(
    (p) => p.shortTitle || p.name
  ) || [];
```

**Add the Alert** inside the `<Panel>` content, before `<ExploreDataFilters>` (~line 96):

```tsx
        {missingNames.length > 0 && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={t("common:filters.missing_params", {
              count: missingNames.length,
              names: missingNames.join(", "),
              defaultValue: `Required parameter${missingNames.length > 1 ? "s" : ""} missing: ${missingNames.join(", ")}. Set a value to resolve nested fields.`,
            })}
          />
        )}
        <ExploreDataFilters
```

**Note:** The `t()` call uses `defaultValue` as a fallback in case the i18n key doesn't exist yet. This is safe and follows the codebase pattern.

### Step 3: Test manually

1. Select a resolved dimension
2. The filter auto-injects with a default value — no warning should show
3. Clear the filter value — warning should appear
4. Set a value — warning disappears

### Step 4: Commit

```bash
cd ../client-v2
git add src/components/ExploreFiltersSection/index.tsx
git commit -m "feat: show warning banner when required FILTER_PARAMS are missing values"
```

---

## Task 9: Disable Run Query When Parameters Are Missing

Disable the "Run Query" button when required FILTER_PARAMS don't have values, with a tooltip explaining why.

**Files:**
- Modify: `../client-v2/src/components/ExploreWorkspace/index.tsx`
- Modify: `../client-v2/src/components/ExploreDataSection/index.tsx`

### Step 1: Pass extended disabled state from ExploreWorkspace

In `../client-v2/src/components/ExploreWorkspace/index.tsx`:

**Compute the flag** (after the `filterParams` destructure, before the JSX):

```typescript
  const hasMissingParams = (filterParams?.missingParams?.length ?? 0) > 0;
```

**Update the `disabled` prop** on `ExploreDataSection` (~line 158):

Replace:
```tsx
      disabled={!isQueryChanged}
```
With:
```tsx
      disabled={!isQueryChanged || hasMissingParams}
```

### Step 2: Add tooltip to the Run button in ExploreDataSection

In `../client-v2/src/components/ExploreDataSection/index.tsx`:

The Run button is at ~line 302-312 and currently looks like:

```tsx
<Button
  className={s.run}
  type="primary"
  onClick={onExec}
  disabled={!queryState?.columns?.length || disabled || loading}
>
  <span style={{ marginRight: 10 }}>
    {t("data_section.run_query")}
  </span>
  <ArrowIcon />
</Button>
```

**Add Tooltip import** if not already present:

```typescript
import { Tooltip } from "antd";
```

**Wrap the Button** with a Tooltip:

```tsx
<Tooltip
  title={disabled ? t("common:filters.set_required_params", {
    defaultValue: "Set required parameter filters before running",
  }) : undefined}
>
  <Button
    className={s.run}
    type="primary"
    onClick={onExec}
    disabled={!queryState?.columns?.length || disabled || loading}
  >
    <span style={{ marginRight: 10 }}>
      {t("data_section.run_query")}
    </span>
    <ArrowIcon />
  </Button>
</Tooltip>
```

**Note:** Ant Design's `Tooltip` doesn't show when `title` is `undefined`, so the tooltip only appears when the button is disabled.

**Important caveat:** Ant Design `Tooltip` does NOT work on disabled buttons by default — the disabled button swallows mouse events. Wrap the button in a `<span>` if needed:

```tsx
<Tooltip
  title={disabled ? t("common:filters.set_required_params", {
    defaultValue: "Set required parameter filters before running",
  }) : undefined}
>
  <span>
    <Button
      className={s.run}
      type="primary"
      onClick={onExec}
      disabled={!queryState?.columns?.length || disabled || loading}
    >
      <span style={{ marginRight: 10 }}>
        {t("data_section.run_query")}
      </span>
      <ArrowIcon />
    </Button>
  </span>
</Tooltip>
```

### Step 3: Test manually

1. Select a resolved dimension but clear the filter values
2. The Run button should be disabled with a tooltip on hover
3. Set a value in the filter → Run button enables

### Step 4: Commit

```bash
cd ../client-v2
git add src/components/ExploreWorkspace/index.tsx src/components/ExploreDataSection/index.tsx
git commit -m "feat: disable Run Query button when required FILTER_PARAMS are missing"
```

---

## Summary of Changes

| Task | Area | What |
|------|------|------|
| 1 | Utility | `filterParamsResolver.ts` — pure functions to detect/resolve FILTER_PARAMS from metadata |
| 2 | Hook | `useFilterParams.ts` — reactive hook with stable references for tracking required/missing params |
| 3 | Wiring | Connect hook through `usePlayground` → `ExploreWorkspace` → `ExploreFiltersSection` |
| 4 | Auto-inject | Auto-add filter with default known value when resolved dimension is selected |
| 5 | UI | Known-values dropdown in filter input (replaces free-text tags) |
| 6 | UI | Visual "P" and "F" tags on parameterized dimensions in sidebar |
| 7 | Cleanup | Auto-remove orphaned FILTER_PARAMS filters when resolved dims are deselected |
| 8 | UX | Warning banner when parameter filters are missing values |
| 9 | UX | Disable Run Query button with tooltip when required params are missing |

### Files Created
- `../client-v2/src/utils/helpers/filterParamsResolver.ts`
- `../client-v2/src/utils/helpers/__tests__/filterParamsResolver.test.ts`
- `../client-v2/src/hooks/useFilterParams.ts`
- `../client-v2/src/hooks/__tests__/useFilterParams.test.ts`

### Files Modified
- `../client-v2/src/hooks/usePlayground.ts` (Tasks 3, 4, 7)
- `../client-v2/src/components/ExploreWorkspace/index.tsx` (Tasks 3, 9)
- `../client-v2/src/components/PlaygroundFilterInput/index.tsx` (Task 5)
- `../client-v2/src/components/ExploreCubesCategoryItem/index.tsx` (Task 6)
- `../client-v2/src/components/ExploreCubesCategoryItem/index.module.less` (Task 6)
- `../client-v2/src/components/ExploreFiltersSection/index.tsx` (Task 8)
- `../client-v2/src/components/ExploreDataSection/index.tsx` (Task 9)

### Architecture Diagram

```
                    ┌─────────────────────┐
                    │   Cube.js Model      │
                    │  meta.nested_lookup_key
                    │  meta.known_values   │
                    │  meta.resolved_by    │
                    └──────────┬──────────┘
                               │ /api/v1/meta
                    ┌──────────▼──────────┐
                    │  useDataSourcesMeta  │
                    │  (CubeMember.meta)   │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                 │
   ┌──────────▼──────┐  ┌─────▼──────┐  ┌──────▼───────┐
   │ useFilterParams  │  │ ExploreCubes│  │ FilterInput  │
   │ requiredParams   │  │ P/F badges │  │ known_values │
   │ missingParams    │  │ (Task 6)   │  │ dropdown     │
   │ (Task 2)        │  └────────────┘  │ (Task 5)     │
   └──────────┬──────┘                   └──────────────┘
              │
   ┌──────────▼──────────────┐
   │ usePlayground            │
   │ • auto-inject (Task 4)   │
   │ • auto-remove (Task 7)   │
   └──────────┬──────────────┘
              │
   ┌──────────▼──────────────┐
   │ ExploreWorkspace         │
   │ • warning banner (Task 8)│
   │ • disable Run (Task 9)   │
   └─────────────────────────┘
```

### Known Limitations / Future Work

1. **i18n keys**: The plan uses `defaultValue` fallbacks for new translation keys (`common:filters.missing_params`, `common:filters.set_required_params`). These should be added to the translation files when available.
2. **Lookup key as standalone dimension**: If a user selects only `classification_type` (the lookup key itself) without any resolved dimensions, no auto-filter is injected. The dimension works but returns `toString(1 = 1)` = `'1'` without a filter. This is acceptable — the field is meaningless without a filter, and the "P" tag hints at its purpose.
3. **Multiple values**: The auto-inject selects the first known value by default. Users can multi-select in the dropdown. Each value creates a separate Cube.js query dimension slice.
