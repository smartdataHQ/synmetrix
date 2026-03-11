# Data Model: Hasura Auth Proxy

**Branch**: `008-hasura-proxy` | **Date**: 2026-03-11

## Overview

This feature introduces **no new database tables or schema changes**. It operates entirely at the request/response layer, using existing entities (users, accounts, teams, members, member_roles) via the established provisioning logic.

The only new data structures are in-memory caches within the CubeJS process.

## New In-Memory Entities

### Minted Token Cache

Caches HS256 Hasura JWTs minted for WorkOS-authenticated users to avoid re-minting on every request.

| Field | Type | Description |
|-------|------|-------------|
| key: userId | string (UUID) | Internal user ID (from provisioning) |
| token | string | Minted HS256 JWT |
| exp | number | Token expiration timestamp (Unix seconds) |

**Lifecycle**:
- Created: On first WorkOS token verification for a given userId
- Reused: While `exp - now > 60s`
- Evicted: When `exp - now <= 60s` (next request triggers re-mint)
- Invalidated: On `type: "user"` or `type: "all"` cache invalidation event

**Constraints**:
- Max 1000 entries
- No persistence — lost on service restart (rebuilt on next request)

## Existing Entities (referenced, not modified)

### Identity Resolution Chain

The proxy reuses the existing provisioning flow which touches these entities in order:

1. **auth_accounts** — Lookup by `workos_user_id`, fallback to `email`
2. **users** — Created if new user; linked via `auth_accounts.user_id`
3. **teams** — Found by derived team name or created; linked via `members`
4. **members** — Join table: `user_id` + `team_id` (unique constraint)
5. **member_roles** — Role assignment: `member_id` + `team_role` (unique constraint)

### Existing Caches (in CubeJS, reused by proxy)

| Cache | Key | TTL | Max Size | Purpose |
|-------|-----|-----|----------|---------|
| workosSubCache | WorkOS `sub` | 5min | 1000 | Sub → userId mapping |
| userCache | userId | 30s | 500 | User profile + datasources |

The proxy's token swap uses `provisionUserFromWorkOS()` which already manages these caches. The minted token cache is the only **new** cache.
