# Data Model: Simple Access Controls

**Branch**: `005-simple-access-controls` | **Date**: 2026-03-09

## Entity Relationship Diagram

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────────┐
│     teams         │     │    members        │     │   member_roles       │
│──────────────────│     │──────────────────│     │──────────────────────│
│ id (uuid PK)     │◄────│ team_id (FK)     │────►│ member_id (FK)       │
│ name (text UQ)   │     │ id (uuid PK)     │     │ id (uuid PK)         │
│ user_id (FK)     │     │ user_id (FK)     │     │ team_role (FK)       │
│ settings (jsonb) │     │ properties (jsonb)│     │ access_list_id (FK)  │
│ created_at       │     │ created_at       │     │ created_at           │
│ updated_at       │     │ updated_at       │     │ updated_at           │
└──────────────────┘     └──────────────────┘     └──────────────────────┘
                                                          │
                                                          ▼
                                                  ┌──────────────────┐
                                                  │  access_lists    │
                                                  │──────────────────│
                                                  │ id (uuid PK)    │
                                                  │ name (text)     │
                                                  │ team_id (FK)    │
                                                  │ config (jsonb)  │
                                                  └──────────────────┘

┌──────────────────────────┐
│  query_rewrite_rules     │  ← NEW TABLE
│──────────────────────────│
│ id (uuid PK)             │
│ cube_name (text)         │
│ dimension (text)         │
│ property_source (text)   │  "team" or "member"
│ property_key (text)      │
│ operator (text)          │  "equals", "notEquals", "contains", etc.
│ created_by (uuid FK)     │
│ created_at (timestamptz) │
│ updated_at (timestamptz) │
└──────────────────────────┘
```

## Entities

### teams (MODIFIED — existing table)

The `settings` JSONB column is extended to store arbitrary team properties. No schema migration needed — the column already exists and accepts arbitrary JSON.

**settings structure**:
```json
{
  "partition": "acme-corp",
  "internal_tables": ["semantic_events", "data_points", "entities"],
  "region": "us-east-1",
  "custom_key": "custom_value"
}
```

- `partition` (string): Primary data isolation key. Set during provisioning from the WorkOS token. Used by query rewriting rules.
- `internal_tables` (string[]): Tables requiring partition filtering at cube generation time (existing behavior).
- Any additional keys: Free-form, created by portal admins. Referenced by name in query rewriting rules.

### members (MODIFIED — existing table)

**New column**: `properties` (jsonb, NOT NULL, DEFAULT `'{}'::jsonb`)

Stores arbitrary key-value pairs on the membership record (user-in-team link). Editable only by portal admins.

**properties structure**:
```json
{
  "entity_id": "12345",
  "department": "engineering"
}
```

- Keys are free-form strings created by portal admins.
- Values are strings.
- Properties are per-membership — the same user can have different properties in different teams.

**Migration required**: `ALTER TABLE public.members ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb;`

### query_rewrite_rules (NEW table)

Global rules that map team or member properties to WHERE clause filters on specific cubes.

| Column | Type | Constraints | Description |
|--------|------|-------------|-------------|
| `id` | uuid | PK, DEFAULT gen_random_uuid() | Unique identifier |
| `cube_name` | text | NOT NULL | Target cube name (e.g., `semantic_events`) |
| `dimension` | text | NOT NULL | Target dimension on the cube — short name only, must not contain `.` (e.g., `partition`, not `semantic_events.partition`). Fully-qualified member is constructed at runtime as `{cube_name}.{dimension}`. |
| `property_source` | text | NOT NULL, CHECK IN ('team', 'member') | Where to read the property value from |
| `property_key` | text | NOT NULL | Key name in team.settings or member.properties (e.g., `partition`) |
| `operator` | text | NOT NULL, DEFAULT 'equals' | Filter operator (matches Cube.js filter operators) |
| `created_by` | uuid | FK → users(id) | Portal admin who created the rule |
| `created_at` | timestamptz | NOT NULL, DEFAULT now() | Creation timestamp |
| `updated_at` | timestamptz | NOT NULL, DEFAULT now() | Last update timestamp |

**Unique constraint**: `(cube_name, dimension, property_source, property_key)` — prevents duplicate rules for the same cube/dimension/source combination.

**Supported operators (MVP)**: `equals` only. The `operator` column is typed as `text` for future extensibility, but the `manageQueryRewriteRule` handler validates that only `equals` is accepted for MVP. Additional operators (`notEquals`, `contains`, `gt`, etc.) may be added in future iterations after type safety is established.

**Example rows**:

| cube_name | dimension | property_source | property_key | operator |
|-----------|-----------|-----------------|--------------|----------|
| semantic_events | partition | team | partition | equals |
| data_points | partition | team | partition | equals |
| entities | partition | team | partition | equals |
| entities | entity_id | member | entity_id | equals |

### auth.accounts (UNCHANGED — reference)

Portal admin detection uses the `email` column on `auth.accounts`. The email domain check (`@snjallgogn.is`) is performed in application code, not via database constraints.

## Data Flow: Query Rewriting

**Applies to**: Cube.js API queries only. SQL API (`runSql`) is out of scope — see spec.md "Out of Scope".

**Coexistence note**: The existing baked-in partition filtering in `cubeBuilder.js` (which injects `WHERE partition = '...'` at cube generation time for `internal_tables`) continues to operate alongside runtime rules. Both are safe to run together (double-filtering is redundant, not conflicting).

```
1. User makes a CubeJS query (via frontend Cube.js API)
   [SQL API: blocked with 403 if team has active rules — see FR-019]
   ↓
2. checkAuth.js verifies JWT, extracts user_id
   ↓
3. findUser() fetches: members[].team.settings, members[].properties (NEW)
   [members.properties fetched via admin-role GraphQL, not user-role SELECT]
   ↓
4. defineUserScope() resolves selected datasource/branch/version
   Returns: userScope with teamProperties and memberProperties (NEW)
   ↓
5. buildSecurityContext() creates dataSourceVersion hash
   [Hash includes teamProperties but NOT memberProperties — prevents cache fragmentation]
   ↓
6. queryRewrite() receives query + securityContext:
   ⚠️ Owner/admin early return REMOVED — all roles are filtered by rules
   a. Load cached query_rewrite_rules (60s TTL)
   b. Extract cube names from query dimensions and measures (split on '.')
   c. For each matching rule:
      - Read property value from teamProperties or memberProperties
      - If property missing → set BLOCKED flag
      - If property present → push { member: "cube.dim", operator: "equals", values: [value] } filter
   d. If ANY cube is blocked → block ENTIRE query (not per-cube)
   e. (Existing) Check field-level access list for non-owner/non-admin members
   ↓
7. CubeJS executes the filtered query against the database
```

## Hasura Permissions

### query_rewrite_rules table

| Role | Operation | Permission |
|------|-----------|------------|
| user | SELECT | Allow all (rules are global, needed by CubeJS to load rules) |
| user | INSERT | Deny (only via RPC action with portal admin check) |
| user | UPDATE | Deny (only via RPC action with portal admin check) |
| user | DELETE | Deny (only via RPC action with portal admin check) |

Write operations go through RPC handlers that verify portal admin status (email domain check).

### members table (updated permissions)

| Role | Operation | Permission |
|------|-----------|------------|
| user | SELECT | Existing: team membership check. Do NOT add `properties` to allowed columns — member properties are access-control metadata, visible only via admin RPC or CubeJS admin-role queries. |
| user | UPDATE | No change — no UPDATE permission for role `user` on members table. All member property changes go through RPC handlers. |

### teams table (MODIFIED permissions)

| Role | Operation | Permission |
|------|-----------|------------|
| user | SELECT | No change. |
| user | UPDATE | **MODIFIED**: Remove `settings` from allowed columns. Settings changes MUST go through `updateTeamSettings` or `updateTeamProperties` RPC handlers. Keep `name` if needed. |

### auth.accounts table (MODIFIED permissions)

| Role | Operation | Permission |
|------|-----------|------------|
| user | UPDATE | **MODIFIED**: Remove `email` from allowed columns. Prevents self-escalation to portal admin. Email changes go through WorkOS only. |
