# Data Model: Query with WorkOS JWT

**Branch**: `007-workos-jwt-query` | **Date**: 2026-03-10

## Existing Entities (No Schema Changes)

### auth_accounts
The identity resolution table. No new columns needed — `workos_user_id` already exists.

| Field | Type | Index | Purpose |
|---|---|---|---|
| id | uuid (PK) | `accounts_pkey` | Primary key |
| user_id | uuid (unique) | `accounts_user_id_key` | FK to users.id |
| email | citext (unique) | `accounts_email_key` | User email |
| workos_user_id | text (unique) | `accounts_workos_user_id_unique` | WorkOS `sub` claim mapping |
| active | boolean | — | Account status |
| default_role | text | — | Default Hasura role |

### users
| Field | Type | Purpose |
|---|---|---|
| id | uuid (PK) | Platform user ID used throughout the system |
| display_name | text | User display name (email fallback if null) |
| avatar_url | text | Profile picture URL |

### teams
| Field | Type | Index | Purpose |
|---|---|---|---|
| id | uuid (PK) | `teams_pkey` | Team ID |
| name | text | `teams_name_unique` (lower, trim) | Derived from JWT partition claim |
| user_id | uuid | — | Team creator |
| settings | jsonb | — | Contains `partition` value |

### members
| Field | Type | Index | Purpose |
|---|---|---|---|
| id | uuid (PK) | `members_pkey` | Membership ID |
| user_id | uuid | `members_user_id_team_id_key` (composite) | FK to users |
| team_id | uuid | `members_user_id_team_id_key` (composite) | FK to teams |

### member_roles
| Field | Type | Index | Purpose |
|---|---|---|---|
| id | uuid (PK) | `member_roles_pkey` | Role assignment ID |
| member_id | uuid | `member_roles_member_id_team_role_key` | FK to members |
| team_role | enum | `member_roles_member_id_team_role_key` | owner/admin/member/viewer |

## New In-Memory Entities

### Identity Mapping Cache (new)
In-memory Map in CubeJS process. Not persisted.

| Field | Type | Purpose |
|---|---|---|
| key: workos_sub | string | WorkOS `sub` claim (e.g., `user_01KEC615YDR3NK2SPGW84ZASR3`) |
| value: user_id | uuid | Platform user ID (e.g., `748e8a31-080f-4532-...`) |
| time | number | Cache entry timestamp (ms) |

**TTL**: 5 minutes | **Max size**: 1000 entries | **Eviction**: FIFO (oldest entry removed when full)

### User Scope Cache (existing, unchanged)
In-memory Map in CubeJS process. Already exists in `dataSourceHelpers.js`.

| Field | Type | Purpose |
|---|---|---|
| key: user_id | uuid | Platform user ID |
| value: data | object | `{ dataSources: [...], members: [...] }` |
| time | number | Cache entry timestamp (ms) |

**TTL**: 30 seconds | **Max size**: 500 entries | **Eviction**: FIFO

## Entity Relationships

```
WorkOS JWT (sub claim)
  └─→ auth_accounts.workos_user_id  [unique index lookup]
       └─→ auth_accounts.user_id
            └─→ users.id
            └─→ members.user_id  [composite index]
                 └─→ members.team_id → teams.id
                 └─→ member_roles.member_id
                      └─→ member_roles.access_list → access control config
                 └─→ team.datasources → datasource resolution
```

## State Transitions

### User Resolution States

```
WorkOS JWT received
  ├─ [Identity cache HIT] → userId known → check user scope cache
  │   ├─ [Scope cache HIT] → fully resolved → execute query
  │   └─ [Scope cache MISS] → findUser(userId) via GraphQL → cache → execute query
  │
  └─ [Identity cache MISS] → DB lookup: auth_accounts WHERE workos_user_id = sub
      ├─ [Account EXISTS] → cache mapping → check user scope cache (above)
      └─ [Account NOT FOUND by workos_user_id]
          ├─ Fetch email from WorkOS API: GET /user_management/users/{sub}
          ├─ DB lookup: auth_accounts WHERE email = fetched_email
          │   ├─ [Account EXISTS, workos_user_id NULL] → backfill workos_user_id → cache mapping → check user scope cache
          │   ├─ [Account EXISTS, workos_user_id SET] → cache mapping → check user scope cache (race condition: another request already backfilled)
          │   └─ [Account NOT FOUND] → JIT Provision (below)
          └─ JIT Provision (new user):
              ├─ Create user (display_name = firstName+lastName or email)
              ├─ Create account (email, workos_user_id) — on_conflict: accounts_email_key
              ├─ Find or create team (from partition claim, _eq lookup) — on_conflict: teams_name_unique
              ├─ Create membership + role — on_conflict: members_user_id_team_id_key
              ├─ Cache identity mapping (ONLY on full success)
              ├─ Cache user scope
              └─ Execute query
```
