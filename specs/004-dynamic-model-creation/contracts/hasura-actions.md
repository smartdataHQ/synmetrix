# Hasura Action Contracts: Dynamic Model Creation

## New Action: profile_table (Query)

**Purpose**: Step 1 of two-step flow — profile a ClickHouse table and return profiling summary for user review.

### actions.graphql

```graphql
type Query {
  profile_table(
    datasource_id: uuid!
    branch_id: uuid!
    table_name: String!
    table_schema: String!
  ): ProfileTableOutput
}

type ProfileTableOutput {
  code: String!
  row_count: Int
  sampled: Boolean!
  sample_size: Int
  columns: [ProfiledColumnOutput]
  array_candidates: [ArrayCandidateOutput]
  primary_keys: [String]
  existing_model: ExistingModelInfo
}

type ExistingModelInfo {
  file_name: String!
  file_format: String!
  has_user_content: Boolean!
  supports_reprofile: Boolean!
  suggested_merge_strategy: String!
}

type ProfiledColumnOutput {
  name: String!
  raw_type: String!
  column_type: String!
  value_type: String!
  has_values: Boolean!
  unique_values: Int
  unique_keys: [String]
  lc_values: jsonb
}

type ArrayCandidateOutput {
  column: String!
  element_type: String!
  suggested_alias: String!
}
```

### actions.yaml

```yaml
- name: profile_table
  definition:
    kind: synchronous
    handler: "{{ACTIONS_URL}}/rpc/profileTable"
    timeout: 180
    forward_client_headers: true
  permissions:
    - role: user
```

---

## New Action: smart_gen_dataschemas (Mutation)

**Purpose**: Step 2 — generate smart model from profiling, merge with existing, save as new version.

### actions.graphql

```graphql
type Mutation {
  smart_gen_dataschemas(
    datasource_id: uuid!
    branch_id: uuid!
    table_name: String!
    table_schema: String!
    array_join_columns: [ArrayJoinInput]
    max_map_keys: Int
    merge_strategy: String
  ): SmartGenOutput
}

input ArrayJoinInput {
  column: String!
  alias: String!
}

type SmartGenOutput {
  code: String!
  message: String
  version_id: uuid
  file_name: String
  changed: Boolean!
}
```

**Note**: Does NOT reuse `GenSourceSchemaOutput`. The `SmartGenOutput` type includes:
- `version_id`: ID of the newly created version (null if `changed: false`)
- `file_name`: Name of the generated/updated model file (e.g., `semantic_events.yml`)
- `changed`: Whether a new version was actually created (false when checksum matches existing, per FR-014)

**`merge_strategy`** (optional, default `"auto"`): Controls how smart generation interacts with an existing model file. Values: `"auto"`, `"merge"`, `"replace"`, `"merge_keep_stale"`. See cubejs-routes.md for full semantics.

### actions.yaml

```yaml
- name: smart_gen_dataschemas
  definition:
    kind: synchronous
    handler: "{{ACTIONS_URL}}/rpc/smartGenSchemas"
    timeout: 180
    forward_client_headers: true
  permissions:
    - role: user
```

---

## Updated Action: update_team_settings (Mutation)

**Purpose**: Allow admin to configure team settings (partition, internal tables).

### actions.graphql

```graphql
type Mutation {
  update_team_settings(
    team_id: uuid!
    settings: jsonb!
  ): UpdateTeamSettingsOutput
}

type UpdateTeamSettingsOutput {
  code: String!
  message: String
}
```

### actions.yaml

```yaml
- name: update_team_settings
  definition:
    kind: synchronous
    handler: "{{ACTIONS_URL}}/rpc/updateTeamSettings"
    timeout: 30
    forward_client_headers: true
  permissions:
    - role: user
```

**Note**: RPC handler validates that the calling user is an owner of the team before applying the update.

---

## Hasura Migration

**Migration name**: `{timestamp}_add_teams_settings_column`

### up.sql

```sql
ALTER TABLE "public"."teams"
  ADD COLUMN "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "public"."teams"."settings"
  IS 'Team-level admin configuration (partition, internal_tables)';
```

### down.sql

```sql
ALTER TABLE "public"."teams"
  DROP COLUMN IF EXISTS "settings";
```

### Hasura metadata tracking

Add `settings` to teams table select/update permissions in `tables.yaml`:
- Select: add to columns list for role `user` (existing membership filter applies)
- Update: add to columns list for role `user` (existing owner-only filter applies)
