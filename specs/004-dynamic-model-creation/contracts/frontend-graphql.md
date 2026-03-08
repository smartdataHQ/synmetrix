# Frontend GraphQL Contracts: Dynamic Model Creation

## New Queries/Mutations (client-v2)

### datasources.gql additions

```graphql
query ProfileTable($datasource_id: uuid!, $branch_id: uuid!, $table_name: String!, $table_schema: String!) {
  profile_table(
    datasource_id: $datasource_id
    branch_id: $branch_id
    table_name: $table_name
    table_schema: $table_schema
  ) {
    code
    row_count
    sampled
    sample_size
    columns {
      name
      raw_type
      column_type
      value_type
      has_values
      unique_values
      unique_keys
    }
    array_candidates {
      column
      element_type
      suggested_alias
    }
    primary_keys
    existing_model {
      file_name
      file_format
      has_user_content
      supports_reprofile
      suggested_merge_strategy
    }
  }
}

mutation SmartGenDataSchemas(
  $datasource_id: uuid!
  $branch_id: uuid!
  $table_name: String!
  $table_schema: String!
  $array_join_columns: [ArrayJoinInput]
  $max_map_keys: Int
  $merge_strategy: String
) {
  smart_gen_dataschemas(
    datasource_id: $datasource_id
    branch_id: $branch_id
    table_name: $table_name
    table_schema: $table_schema
    array_join_columns: $array_join_columns
    max_map_keys: $max_map_keys
    merge_strategy: $merge_strategy
  ) {
    code
    message
    version_id
    file_name
    changed
  }
}
```

### teams.gql (new file or addition)

```graphql
mutation UpdateTeamSettings($team_id: uuid!, $settings: jsonb!) {
  update_team_settings(team_id: $team_id, settings: $settings) {
    code
    message
  }
}

query TeamSettings($team_id: uuid!) {
  teams_by_pk(id: $team_id) {
    id
    settings
  }
}
```

## Frontend Hooks (new/modified)

### useSources.ts additions

```typescript
// New exports:
useProfileTableQuery        // Lazy query for step 1 profiling
useSmartGenDataSchemasMutation  // Mutation for step 2 generation
```

### New hook: useTeamSettings.ts

```typescript
// Manages team settings CRUD for admin users
useTeamSettingsQuery         // Read team settings
useUpdateTeamSettingsMutation // Update settings (owner only)
```

## UI Flow

### Smart Generation (two-step)

1. User opens DataModelGeneration modal
2. For ClickHouse datasources, a "Smart Generate" option appears alongside standard
3. User selects table and clicks "Smart Generate"
4. **Step 1**: Frontend calls `ProfileTable` query (with `branch_id`) → shows profiling summary:
   - Column count, row count, Map keys discovered
   - Array candidates with checkboxes for ARRAY JOIN selection
   - Primary key detection results
   - **If `existing_model` is non-null in response**: Shows merge options panel (see below), using `has_user_content` and `suggested_merge_strategy` for defaults
   - **If `existing_model.file_format` is `"js"`**: Shows warning that smart generation will create a new `.yml` file alongside the existing `.js` file
5. User reviews summary, selects array columns to flatten, adjusts merge options if needed, confirms
6. **Step 2**: Frontend calls `SmartGenDataSchemas` mutation with selected `merge_strategy`
7. On success: refreshes version list, opens generated model in editor

### Merge Options (shown when existing model detected in step 1 preview)

When the profiling preview detects an existing model file for the selected table:

- **"Preserve custom changes"** toggle (default: ON when user content detected, OFF when no user content)
  - ON → sends `merge_strategy: "merge"`
  - OFF → sends `merge_strategy: "replace"` (with confirmation warning: "This will discard your custom fields, joins, and descriptions. Previous version preserved in history.")
- **"Keep removed columns"** toggle (default: OFF, only visible when "Preserve custom changes" is ON)
  - ON → sends `merge_strategy: "merge_keep_stale"`
  - OFF → sends `merge_strategy: "merge"` (stale auto fields are removed)
- When no existing model is detected: no merge options shown, `merge_strategy` omitted (defaults to `"auto"` on backend)

### Re-Profile

1. User views a smart-generated model in the code editor
2. ModelsSidebar shows "Re-profile" button (only for models with source provenance metadata)
3. User clicks "Re-profile"
4. Frontend extracts provenance from model YAML metadata (source_table, source_database)
5. Shows compact merge options (same toggles as smart generation: "Preserve custom changes" default ON, "Keep removed columns" default OFF)
6. Calls `SmartGenDataSchemas` mutation with extracted table info and selected `merge_strategy`
7. On success: refreshes version, reloads model in editor

### Team Settings (admin)

1. Admin navigates to team settings area
2. Sees partition and internal tables configuration
3. Can set partition value (string input)
4. Can manage internal tables list (add/remove table names)
5. Calls `UpdateTeamSettings` mutation on save

### SSE Progress Handling

For real-time progress during profiling and generation, the frontend connects directly to CubeJS REST endpoints (bypassing Hasura Actions) via the existing `/api/v1/*` proxy path.

**Connection**: Uses `fetch()` with `ReadableStream` parsing (not `EventSource`, which doesn't support POST or custom headers).

```typescript
// In DataModelGeneration component or dedicated hook:
const response = await fetch('/api/v1/profile-table', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream',
    'Authorization': `Bearer ${token}`,
    'x-hasura-datasource-id': datasourceId,
    'x-hasura-branch-id': branchId,
  },
  body: JSON.stringify({ table, schema, branchId }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
// Parse SSE events from stream, update progress state
```

**Progress UI**: Shows within the profiling summary preview area:
- Step name (e.g., "Analyzing schema...", "Profiling columns 11-20 of 28...")
- Progress bar (0-100% based on `progress` field)
- On `complete` event: transitions to the profiling summary / generation result view
- On `error` event: displays error message with retry option

**Fallback**: If SSE connection fails, falls back to the Hasura Action path (no progress, just final result). The GraphQL mutations remain the canonical API — SSE is a UX enhancement.

**Two paths coexist**:
- **GraphQL path** (Hasura Actions): `ProfileTable` query + `SmartGenDataSchemas` mutation — synchronous, no progress
- **SSE path** (direct CubeJS): `POST /api/v1/profile-table` + `POST /api/v1/smart-generate` — streaming progress

The frontend prefers the SSE path for interactive use. The GraphQL path remains for backward compatibility and non-browser clients.

## Codegen Impact

After adding new `.gql` files/mutations, run:
```bash
cd ../client-v2 && yarn codegen
```

This regenerates `src/graphql/generated.ts` with new TypeScript types and URQL hooks.
