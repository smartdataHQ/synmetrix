# RPC Action Contracts: Simple Access Controls

**Branch**: `005-simple-access-controls` | **Date**: 2026-03-09

## New RPC Actions

These actions follow the existing pattern: Hasura GraphQL action → `POST http://actions:3000/rpc/{method}`. Each handler receives `(session_variables, input, headers)`.

### updateTeamProperties

**Purpose**: Update arbitrary properties on a team's settings. Portal admin only.

**Hasura Action**: `update_team_properties`
**Handler**: `services/actions/src/rpc/updateTeamProperties.js`

**Input**:
```graphql
input UpdateTeamPropertiesInput {
  team_id: uuid!
  properties: jsonb!  # Key-value pairs to merge into team.settings
}
```

**Output**:
```graphql
type UpdateTeamPropertiesOutput {
  success: Boolean!
}
```

**Authorization**: Handler verifies caller's email ends with `@snjallgogn.is` via lookup from `x-hasura-user-id` → `auth.accounts.email`.

**Behavior**: Merges `properties` into existing `team.settings`. Existing keys not in `properties` are preserved. To delete a key, pass `null` as the value.

---

### updateMemberProperties

**Purpose**: Update arbitrary properties on a member's properties field. Portal admin only.

**Hasura Action**: `update_member_properties`
**Handler**: `services/actions/src/rpc/updateMemberProperties.js`

**Input**:
```graphql
input UpdateMemberPropertiesInput {
  member_id: uuid!
  properties: jsonb!  # Key-value pairs to merge into member.properties
}
```

**Output**:
```graphql
type UpdateMemberPropertiesOutput {
  success: Boolean!
}
```

**Authorization**: Handler verifies caller's email ends with `@snjallgogn.is`.

**Behavior**: Merges `properties` into existing `member.properties`. To delete a key, pass `null`.

---

### manageQueryRewriteRule

**Purpose**: Create, update, or delete a query rewriting rule. Portal admin only.

**Hasura Action**: `manage_query_rewrite_rule`
**Handler**: `services/actions/src/rpc/manageQueryRewriteRule.js`

**Input**:
```graphql
input ManageQueryRewriteRuleInput {
  action: String!         # "create", "update", "delete"
  id: uuid                # Required for update/delete
  cube_name: String       # Required for create. Validated against known cube names.
  dimension: String       # Required for create. Short name only (must not contain '.').
  property_source: String # "team" or "member", required for create
  property_key: String    # Required for create
  operator: String        # MVP: must be "equals" (only supported operator). Default "equals".
}
```

**Output**:
```graphql
type ManageQueryRewriteRuleOutput {
  success: Boolean!
  rule_id: uuid
}
```

**Authorization**: Handler verifies caller's email ends with `@snjallgogn.is`.

---

### listAllTeams

**Purpose**: List all teams in the system with their settings/properties. Portal admin only.

**Hasura Action**: `list_all_teams`
**Handler**: `services/actions/src/rpc/listAllTeams.js`

**Input**:
```graphql
input ListAllTeamsInput {
  limit: Int
  offset: Int
}
```

**Output**:
```graphql
type ListAllTeamsOutput {
  teams: [TeamInfo!]!
  total: Int!
}

type TeamInfo {
  id: uuid!
  name: String!
  settings: jsonb
  member_count: Int!
  created_at: String!
}
```

**Authorization**: Handler verifies caller's email ends with `@snjallgogn.is`.

## Modified RPC Actions

### updateTeamSettings (MODIFIED)

**Change**: Add portal admin authorization as an alternative to team owner check. Portal admins (`@snjallgogn.is`) can update any team's settings. Existing team owner authorization remains for non-admin users editing their own team.

**Access-control key protection**: On the owner path (non-portal-admin), the handler MUST strip keys that are referenced by active `query_rewrite_rules` where `property_source = 'team'` (e.g., `partition`). This prevents team owners from overwriting or deleting security properties. Portal admins bypass this restriction.

## GraphQL Queries (Direct Hasura)

### query_rewrite_rules

Portal admins and CubeJS need to read rules. SELECT permission is open for role `user` since rules are global and non-sensitive.

```graphql
query QueryRewriteRules {
  query_rewrite_rules(order_by: { cube_name: asc }) {
    id
    cube_name
    dimension
    property_source
    property_key
    operator
    created_at
    updated_at
  }
}
```

### Members with Properties

Extended query for portal admin view — fetches members across all teams with their properties.

```graphql
query TeamMembers($team_id: uuid!) {
  members(where: { team_id: { _eq: $team_id } }) {
    id
    user_id
    properties
    user {
      display_name
      account {
        email
      }
    }
    member_roles {
      team_role
    }
  }
}
```

## Provisioning Contract Change

### callback.js → provision.js

The `provisionUser()` function signature is extended to accept a `partition` parameter extracted from the WorkOS authentication result:

```javascript
// Before
await provisionUser(user);

// After
// Extraction path must be confirmed with WorkOS integration
const partition = authResult.organizationId || authResult.partition || null;
await provisionUser(user, { partition });
```

**Important**: Team name continues to be derived from email domain (existing logic in `assignTeamToUser`). The partition is a separate value stored in `team.settings`, NOT the team name. Example: user `user@acme.com` → team name "acme.com", partition "acme-corp" (from WorkOS token).

The `assignTeamToUser()` function passes `partition` to `createTeam()`:

```javascript
// Before
const teamId = await createTeam(teamName, userId);

// After — teamName still comes from email domain, partition is stored in settings
const teamId = await createTeam(teamName, userId, partition ? { partition } : {});
```

When a team already exists (second user from same domain), the partition is NOT overwritten — the existing team's partition is preserved. If the new user's token has a different partition value, log a warning.
