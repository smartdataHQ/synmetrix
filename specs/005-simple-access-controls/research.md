# Research: Simple Access Controls

**Branch**: `005-simple-access-controls` | **Date**: 2026-03-09

## R1: Team Properties Storage

**Decision**: Extend existing `teams.settings` JSONB column for team properties.

**Rationale**: The `settings` column already stores `partition` and `internal_tables`. It's fetched by the CubeJS `userQuery` in `dataSourceHelpers.js` and flows through `defineUserScope` → `buildSecurityContext`. Adding arbitrary key-value properties here requires zero schema changes for the team side.

**Alternatives considered**:
- Dedicated `team_properties` table: Rejected — adds a JOIN and a migration for no benefit. JSONB already supports arbitrary keys.
- Separate JSONB column: Rejected — `settings` already serves this purpose.

## R2: Member Properties Storage

**Decision**: Add a `properties` JSONB column to the `members` table via Hasura migration.

**Rationale**: The `members` table currently has no properties/settings column. The existing `roles` JSONB column is legacy (superseded by `member_roles` table). A new `properties` column with default `'{}'::jsonb` cleanly stores arbitrary key-value pairs per membership. This column maps directly to the spec requirement of "properties on the membership record, not the user record."

**Alternatives considered**:
- Nested in `team.settings` under `members[id]`: Rejected — breaks normalization, bloats the team record, and makes per-member queries awkward.
- Reuse `roles` column: Rejected — semantically different, legacy data may exist.

## R3: Query Rewriting Rules Storage

**Decision**: Create a dedicated `query_rewrite_rules` table in PostgreSQL, managed through Hasura.

**Rationale**: Rules are global (not per-team), managed by portal admins, and need their own CRUD lifecycle. A dedicated table follows the existing `access_lists` pattern. Schema: `id` (uuid), `cube_name` (text), `dimension` (text), `property_source` (text — "team" or "member"), `property_key` (text), `operator` (text), `created_at`, `updated_at`, `created_by` (uuid FK to users).

**Alternatives considered**:
- Nested in `team.settings`: Rejected — rules are global, not per-team. Would require duplication or a separate "system settings" table.
- Config file: Rejected — not editable at runtime through UI; violates SC-003 (no restart/redeployment needed).

## R4: Portal Admin Detection

**Decision**: Check user email domain (`@snjallgogn.is`) at three levels: (1) frontend via `currentUser.email`, (2) backend RPC handlers via email lookup from `x-hasura-user-id`, (3) Hasura permissions via a computed/lookup approach.

**Rationale**: Email is already available on the frontend via `CurrentUserStore.currentUser.email`. On the backend, email can be fetched from `auth.accounts` using `user_id` (existing pattern in `provision.js`). No JWT changes needed — the portal admin check is a server-side email lookup, not a JWT claim.

**CRITICAL PREREQUISITE**: The Hasura UPDATE permission on `auth.accounts.email` for role `user` MUST be removed first. Currently users can change their own email, which would allow self-escalation to portal admin by changing to `@snjallgogn.is`. After removing this permission, email is set only during WorkOS authentication and cannot be changed by users.

**Alternatives considered**:
- Add `is_portal_admin` claim to JWT: Rejected — adds complexity to JWT minting and would require token refresh on role change.
- Add `is_portal_admin` column to users: Rejected — admin status is derived from email domain, not assigned. Adding a column creates a sync problem.
- Hasura role `portal_admin`: Rejected — would require changing JWT minting to include this role. Simpler to use RPC handlers with email domain checks.

## R5: CubeJS Query Rewrite Integration

**Decision**: Extend `queryRewrite.js` to load global rules and inject filters based on team/member properties from `securityContext.userScope`. Remove the existing early return bypass for owner/admin roles.

**Rationale**: The existing `queryRewrite` function already receives `securityContext.userScope` which contains `role`, `dataSourceAccessList`, and `dataSource` (with team settings like `partition`). The extension path:
1. **Remove the owner/admin bypass** (lines 26-28 in current code). The spec requires all roles to be filtered. Owners/admins may still bypass the field-level access list check, but NOT the rule-based row filtering.
2. `defineUserScope.js` already receives `teamSettings` — extend it to also pass full `team.settings` (all properties) and new `member.properties` into the returned `userScope`.
3. `queryRewrite.js` loads rules from a cache (fetched from `query_rewrite_rules` table), checks which cubes the query involves, and pushes `{ member, operator, values }` filter objects into `query.filters`.
4. Missing property values → return empty results per spec (secure by default).

**SQL API note**: The `runSql` route and CubeJS SQL endpoints bypass `queryRewrite` entirely. This is an accepted limitation for MVP — SQL API is explicitly out of scope for access control rules.

**Alternatives considered**:
- `SECURITY_CONTEXT` in cube SQL: Rejected — deprecated in Cube.js v1.4+, doesn't support YAML, and bakes filters into model definitions.
- `access_policy` with `row_level.filters`: Investigated — newer Cube.js feature, but requires embedding rules in each cube model file. Doesn't support runtime-configurable rules from a database table.
- Cube source SQL (`WHERE partition = '...'`): Already partially implemented for `internal_tables`. Works but is static (baked at generation time). Not suitable for dynamic per-request filtering.

## R6: Provisioning Partition Write

**Decision**: Modify `createTeam()` in `provision.js` to accept initial settings, including `partition` from the WorkOS token.

**Rationale**: Currently `createTeam(name, userId)` creates a team with no settings. The WorkOS callback (`callback.js`) has access to the authentication result which now includes a `partition` claim. The partition should be extracted in `callback.js` and passed through to `provisionUser()` → `assignTeamToUser()` → `createTeam()`. The GraphQL mutation already supports a `settings` field on the `teams` table.

**Alternatives considered**:
- Separate update after creation: Rejected — creates a window where the team exists without a partition, and any concurrent provisioning would miss it.

## R7: Frontend Admin UI Location

**Decision**: Add admin-only sections within the existing `SettingsLayout` sidebar, gated by email domain check.

**Rationale**: The `SettingsLayout` already conditionally shows/hides menu items based on role (e.g., "Roles & Access" hidden for members). Adding admin items follows the same pattern: check `currentUser.email.endsWith('@snjallgogn.is')` and conditionally include menu items. Three admin pages: (1) Team Properties (all teams), (2) Member Properties, (3) Query Rewriting Rules.

**Alternatives considered**:
- Separate admin layout/route tree: Rejected — over-engineered for 3 pages. SettingsLayout already handles conditional items.
- SideMenu (top-level): Rejected — admin items are settings-adjacent, not primary navigation.

## R8: Rules Caching in CubeJS

**Decision**: Cache query rewriting rules in memory with a short TTL (60 seconds), refreshed via a GraphQL query to the `query_rewrite_rules` table.

**Rationale**: Rules change rarely (portal admin edits). Loading them from the database on every request would add latency. A 60-second cache means rule changes take effect within 60 seconds (satisfies SC-003: "within 60 seconds, no restart needed") while keeping the query path fast. Note: SC-003 explicitly states the 60-second freshness SLA, not "next query execution."

**Alternatives considered**:
- No cache (fetch every request): Rejected — adds a GraphQL round-trip to every CubeJS query.
- Long TTL or manual invalidation: Rejected — manual invalidation adds complexity; 60s is a reasonable trade-off.
