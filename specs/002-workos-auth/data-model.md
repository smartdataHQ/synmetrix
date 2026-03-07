# Data Model: WorkOS Authentication (Port from cxs2)

## Redis Session (Ported from cxs2)

**Source**: `cxs2/src/lib/auth/session.ts` — Session interface and Redis CRUD operations.

**Key pattern**: `session:{sessionId}` (same as cxs2)
**TTL**: 86400 seconds (24 hours), sliding window via `redis.expire()` on each `GET /auth/token` call (same as cxs2)

**Important**: Only `GET /auth/token` requests extend the session TTL. GraphQL requests go directly to Hasura (bypassing Actions), so normal application usage does not extend the session unless the frontend periodically calls `/auth/token`.

### Session Shape

Ported from cxs2's `Session` interface, adapted for Synmetrix entities:

```json
{
  "sessionId": "string (from WorkOS JWT sid claim — same extraction as cxs2: jose.decodeJwt(accessToken).sid)",
  "workosSessionId": "string (WorkOS session ID — same as cxs2)",
  "userId": "uuid (public.users.id — replaces cxs2's Convex user ID)",
  "accessToken": "string (Hasura-compatible JWT, ~15 min TTL — replaces cxs2's WorkOS accessToken for Convex)",
  "refreshToken": "string (WorkOS refresh token — same as cxs2)",
  "workosAccessToken": "string (WorkOS JWT — kept for token refresh via authenticateWithRefreshToken)",
  "user": {
    "id": "uuid (public.users.id — replaces cxs2's Convex ID)",
    "workosId": "string (WorkOS user ID — same as cxs2)",
    "email": "string (same as cxs2)",
    "displayName": "string | null (maps to cxs2's firstName + lastName)"
  },
  "teamId": "uuid (public.teams.id — replaces cxs2's organizationId)",
  "createdAt": "ISO 8601 string (same as cxs2)"
}
```

### cxs2 → Synmetrix Field Mapping

| cxs2 Session Field | Synmetrix Session Field | Notes |
|---------------------|-------------------------|-------|
| `userId` (Convex ID) | `userId` (PostgreSQL UUID) | Different ID system, same purpose |
| `organizationId` (Convex ID) | `teamId` (PostgreSQL UUID) | cxs2 orgs = Synmetrix teams |
| `accessToken` (WorkOS JWT) | `workosAccessToken` | Kept for refresh; Synmetrix also stores `accessToken` as Hasura JWT |
| `user.firstName` + `user.lastName` | `user.displayName` | Synmetrix users table has `display_name`, not first/last |
| `organization` object | Not stored | Team info fetched from DB when needed |
| `availableOrganizations` | Not stored | Synmetrix teams resolved via `members` table |
| `organizationMembershipWorkosId` | Not stored | Not needed until WorkOS FGA migration |

## PostgreSQL Entities

### Schema Changes Required

This feature requires one Hasura migration to add `workos_user_id` to `auth.accounts` and fix the team uniqueness constraint.

### public.users (existing, no changes)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | gen_random_uuid(), used as `x-hasura-user-id` in JWT |
| display_name | text | nullable, set from WorkOS `user.firstName + user.lastName` |
| avatar_url | text | nullable, set from WorkOS `user.profilePictureUrl` |
| created_at | timestamptz | DEFAULT now() |
| updated_at | timestamptz | DEFAULT now() |

### auth.accounts (existing + new column)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | gen_random_uuid() |
| user_id | uuid (FK → users.id) | NOT NULL |
| email | citext | Set from WorkOS user email |
| **workos_user_id** | **text** | **NEW. Set from WorkOS `user.id`. UNIQUE. Primary key for JIT provisioning lookups.** |
| active | boolean | Set to `true` for WorkOS users |
| default_role | text | Set to `'user'` |
| password_hash | text | NULL for WorkOS users (no local passwords) |

**New constraint**: `UNIQUE (workos_user_id)` — ensures one local account per WorkOS identity.

### public.teams (existing + constraint change)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | gen_random_uuid() |
| name | text | NOT NULL, set to email domain (e.g., `example.com`) or personal workspace name |
| user_id | uuid | FK → users.id, set to first user who creates the team |

**Constraint change**: Current schema has `UNIQUE (user_id, name)`. Add `UNIQUE (name)` to prevent duplicate teams for the same domain. This is safe because team names are email domains (unique by nature) or personal workspace identifiers.

### public.members (existing, no changes)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | gen_random_uuid() |
| user_id | uuid (FK → users.id) | NOT NULL, ON DELETE CASCADE |
| team_id | uuid (FK → teams.id) | NOT NULL, ON DELETE CASCADE |

**Constraint**: UNIQUE (user_id, team_id)

### public.member_roles (existing, no changes)
| Column | Type | Notes |
|--------|------|-------|
| id | uuid (PK) | gen_random_uuid() |
| member_id | uuid (FK → members.id) | NOT NULL, ON DELETE CASCADE |
| team_role | text (FK → team_roles.name) | `'owner'` if user created team, else `'member'` |

## Consumer Domain Blocklist

Consumer email domains (gmail.com, outlook.com, hotmail.com, yahoo.com, icloud.com, aol.com, protonmail.com, etc.) must NOT create shared teams. Instead, users with consumer emails get a personal workspace.

**Implementation**: Maintain a blocklist array in `provision.js`. When the email domain is on the blocklist:
- Team name = user's full email address (e.g., `user@gmail.com`) instead of the domain
- This creates a personal, single-user workspace
- The user is the owner of their personal workspace

## JIT Provisioning (Adapted from cxs2 `performJITSync()`)

**Source**: `cxs2/src/lib/services/sync.ts` — JIT sync logic for Convex.
**Adaptation**: Same concept, targets PostgreSQL via Hasura admin GraphQL instead of Convex mutations.

```
WorkOS authenticateWithCode() returns { user, organizationId, accessToken, refreshToken }
  ↓
(same as cxs2: extract user identity)
  ↓
Query auth.accounts WHERE workos_user_id = user.id (PRIMARY lookup — new, not in cxs2)
  ↓
If no match: fallback to WHERE email = user.email (SECONDARY lookup — same as cxs2)
  ↓
If no account exists:
  1. INSERT INTO public.users (display_name, avatar_url)
     → display_name = [user.firstName, user.lastName].filter(Boolean).join(' ')
     → avatar_url = user.profilePictureUrl
  2. INSERT INTO auth.accounts (user_id, email, workos_user_id, active=true, default_role='user')
  3. Extract email_domain = user.email.split('@')[1]
  4. Check consumer domain blocklist
  5. If consumer domain:
     → team_name = user.email (personal workspace)
  6. If business domain:
     → team_name = email_domain
  7. Query public.teams WHERE name = team_name
  8. If no team: INSERT INTO public.teams (name=team_name, user_id=new_user.id)
  9. INSERT INTO public.members (user_id, team_id)
  10. INSERT INTO public.member_roles (member_id, team_role)
     → 'owner' if user created the team in step 8, else 'member'
  ↓
If account found but workos_user_id is NULL:
  → UPDATE auth.accounts SET workos_user_id = user.id (backfill for existing users)
  ↓
Return users.id for JWT minting (Synmetrix-specific: cxs2 returns Convex user ID)
```

## Session Lifecycle (Same as cxs2)

```
[No Session] --sign-in callback--> [Active] --GET /auth/token--> [Active, TTL reset via redis.expire()]
[Active] --24h without token refresh--> [Expired] --access /auth/token--> 401 → frontend redirects to /signin
[Active] --POST /auth/signout--> [Destroyed via redis.del()] → frontend redirects to /signin
```

Note: The frontend's URQL `authExchange` calls `GET /auth/token` before JWT expiry (~15 min), which implicitly extends the session. As long as the user has the app open and active, the session stays alive.

## JWT Lifecycle

```
[Sign-in callback] --generateUserAccessToken(userId)--> [JWT minted, ~15 min TTL]
[JWT in session] --GET /auth/token--> [Fresh JWT returned to frontend]
[JWT approaching expiry] --URQL authExchange.willAuthError--> [GET /auth/token] --new JWT minted--> [Session updated]
[JWT expired + session valid] --GET /auth/token--> [New JWT minted from session data]
[JWT expired + session expired] --GET /auth/token--> [401] --frontend--> [redirect to /signin]
```

Note: JWTs are not revocable at the Hasura/CubeJS layer. After sign-out, any previously-issued JWT remains valid until its ~15 min TTL expires. This is an acceptable trade-off given the short TTL.
