# Tasks: Simple Access Controls

**Input**: Design documents from `/specs/005-simple-access-controls/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: Required per Constitution Principle III (TDD). StepCI integration tests for RPC handlers, Vitest for frontend.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Database migrations and Hasura metadata that all stories depend on

- [x] T001 Create Hasura migration `up.sql` in `services/hasura/migrations/{timestamp}_add_member_properties_and_query_rewrite_rules/up.sql`: (1) `ALTER TABLE public.members ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb;` (2) Create `query_rewrite_rules` table with columns: id (uuid PK), cube_name (text NOT NULL), dimension (text NOT NULL), property_source (text NOT NULL CHECK IN ('team','member')), property_key (text NOT NULL), operator (text NOT NULL DEFAULT 'equals'), created_by (uuid FK users), created_at, updated_at; unique constraint on (cube_name, dimension, property_source, property_key); updated_at trigger
- [x] T002 Create matching `down.sql` in `services/hasura/migrations/{timestamp}_add_member_properties_and_query_rewrite_rules/down.sql`: drop `query_rewrite_rules` table, remove `properties` column from members
- [x] T003 Update `services/hasura/metadata/tables.yaml`: (1) add `query_rewrite_rules` table definition with SELECT permission for role `user` (all columns, no filter); explicitly deny INSERT/UPDATE/DELETE for role `user`; (2) **SECURITY: Do NOT add `properties` to the `members` table SELECT allowed columns for role `user`** — member properties are access-control metadata, not visible to other team members. CubeJS fetches them using admin-role GraphQL. Portal admins read them via RPC action; (3) **SECURITY: Remove UPDATE permission on `auth.accounts.email` for role `user`** — prevents self-escalation to portal admin by changing email to `@snjallgogn.is`. Email changes must go through WorkOS only; (4) **SECURITY: Remove `settings` from the `teams` table UPDATE allowed columns for role `user`** — all settings changes must go through `updateTeamSettings` or `updateTeamProperties` RPC handlers. Keep `name` in allowed columns if needed
- [x] T004 Add Hasura action definitions in `services/hasura/metadata/actions.yaml` and input/output types in `services/hasura/metadata/actions.graphql` for: `update_team_properties`, `update_member_properties`, `manage_query_rewrite_rule`, `list_all_teams` — all pointing to `POST http://actions:3000/rpc/{method}` per existing pattern

**Checkpoint**: Database schema ready, Hasura metadata configured. Apply migration with `./cli.sh hasura cli "migrate apply"`.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared utility and CubeJS pipeline changes that MUST be complete before user stories

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [x] T005 Create portal admin utility in `services/actions/src/utils/portalAdmin.js`: export `isPortalAdmin(userId)` function that queries `auth.accounts` by user_id, extracts email, returns `email.endsWith('@snjallgogn.is')`. Use existing `fetchGraphQL` pattern from `provision.js`
- [x] T006 [P] Extend `services/cubejs/src/utils/dataSourceHelpers.js`: add `properties` field to the members query in `userQuery` GraphQL string so member properties are fetched alongside team.settings. Note: this query runs with the CubeJS service's admin-level Hasura access, not the user's role — so it can read `members.properties` even though the user role SELECT doesn't include that column
- [x] T007 [P] Extend `services/cubejs/src/utils/defineUserScope.js`: extract `member.properties` (from the member matching the selected team) and full `team.settings` as `teamProperties`; return both `teamProperties` and `memberProperties` in the `userScope` object alongside existing `role` and `dataSourceAccessList`
- [x] T008 Extend `services/cubejs/src/utils/buildSecurityContext.js`: include `teamProperties` (all team.settings keys) and `memberProperties` in the returned security context object. Include only `teamProperties` in the `dataSourceVersion` hash (so teams with different properties get different cache buckets). Do NOT include `memberProperties` in the hash — member-specific filters are applied at query time via `queryRewrite`, not at cache level. This prevents cache over-fragmentation with hundreds of members

- [x] T008a [P] Block SQL API for secured teams in `services/cubejs/src/routes/runSql.js`: before executing the SQL query, check whether the user's team has active `query_rewrite_rules` (can reuse the same cached rules from `queryRewrite.js`). If rules exist for any cube, reject with 403: "SQL API access is not available for teams with active access control rules. Use the Cube.js API instead." This prevents data exfiltration via raw SQL which bypasses `queryRewrite`

**Checkpoint**: Foundation ready — portal admin check available, CubeJS security context carries team/member properties, SQL API blocked for secured teams.

---

## Phase 3: User Story 1 — Team Provisioning with Partition (Priority: P1) 🎯 MVP

**Goal**: Partition from WorkOS token flows into team properties during provisioning, and the CubeJS query rewriting engine applies partition-based filters to `semantic_events`, `data_points`, and `entities`.

**Independent Test**: Sign in two users from different organizations → verify each only sees their own partition's data when querying the three target cubes.

### Tests for User Story 1

- [x] T009 [US1] Create StepCI test for provisioning with partition in `tests/workflows/access-controls/provisioning.yaml`: test that signing in with a partition token creates team with partition in settings; test that signing in without partition creates team without partition (and logs warning); test second user from same org joins existing team
- [x] T010 [US1] Create StepCI test for query rewriting in `tests/workflows/access-controls/query-rewrite.yaml`: test that queries to semantic_events/data_points/entities include partition filter; test that missing partition property blocks the ENTIRE query (empty results for all cubes, not just the blocked one); test that multiple rules on same cube combine with AND logic; test that team owner and team admin roles are NOT exempt from filtering (no bypass); test that SQL API (`/api/v1/run-sql`) returns 403 for users whose team has active rules

### Implementation for User Story 1

- [x] T011 [US1] Modify `services/actions/src/auth/callback.js`: after `workos.userManagement.authenticateWithCode()`, extract `partition` from the auth result (e.g., `authResult.partition || authResult.user?.partition || null`) and pass it to `provisionUser(user, { partition })`
- [x] T012 [US1] Modify `services/actions/src/auth/provision.js`: (1) update `provisionUser` to accept options object with `partition`; (2) pass `partition` through to `assignTeamToUser`; (3) update `createTeam(name, userId)` to accept optional `initialSettings` parameter and include it in the `insert_teams_one` mutation as `settings: initialSettings`; (4) when partition is provided, pass `{ partition }` as initialSettings; (5) log a warning if no partition in token
- [x] T013 [US1] Extend `services/cubejs/src/utils/queryRewrite.js`: (1) **CRITICAL: Remove the early return on lines 26-28 that bypasses filtering for owner/admin roles** — all roles must be filtered by rules. Owners/admins still bypass the field-level access list check only; (2) add a `loadRules()` function that fetches all rows from `query_rewrite_rules` via GraphQL, cached in a module-level Map with 60-second TTL (export this function so `runSql.js` can reuse it for SQL API blocking); (3) in the main `queryRewrite` function, apply rule-based filtering BEFORE the existing field-level access list check; extract cube names from query dimensions and measures only (split on `.` to get cube name prefix — Cube.js queries don't have explicit joins); (4) for each rule matching a cube in the query: read value from `securityContext.userScope.teamProperties[key]` (if source='team') or `securityContext.userScope.memberProperties[key]` (if source='member'); if value is undefined/null, set a `blocked` flag; if value present, push `{ member: "{rule.cube_name}.{rule.dimension}", operator: "equals", values: [value] }` into `query.filters`; (5) **if ANY cube is blocked (missing property), block the ENTIRE query** — return a query with an impossible filter on every cube member in the query, guaranteeing empty results. Do not return partial results for multi-cube queries, as partial data in joined queries is non-deterministic and could leak data; (6) then run existing field-level access list check for non-owner/non-admin roles
- [x] T014 [US1] Seed initial query rewriting rules: create a seed script or migration that inserts 3 rules into `query_rewrite_rules`: (semantic_events, partition, team, partition, equals), (data_points, partition, team, partition, equals), (entities, partition, team, partition, equals). Can be a SQL insert in the migration up.sql or a separate seed file

**Checkpoint**: User Story 1 complete — provisioning writes partition to team.settings, queryRewrite injects partition filters. Verify by signing in and querying data.

---

## Phase 4: User Story 4 — Portal Admin Identification and UI Gating (Priority: P2)

**Goal**: Users with `@snjallgogn.is` email see admin-only navigation and pages. Backend enforces admin check on all admin operations.

**Independent Test**: Sign in with `@snjallgogn.is` email → see admin menu items. Sign in with other email → no admin items visible.

### Tests for User Story 4

- [x] T015 [US4] Create Vitest test for `usePortalAdmin` hook in `../client-v2/src/hooks/__tests__/usePortalAdmin.test.ts`: test returns true for `@snjallgogn.is` email, false for other domains, false when no email

### Implementation for User Story 4

- [x] T016 [P] [US4] Create `usePortalAdmin` hook in `../client-v2/src/hooks/usePortalAdmin.ts`: import `CurrentUserStore`, return `{ isPortalAdmin: currentUser?.email?.endsWith('@snjallgogn.is') ?? false }`
- [x] T017 [P] [US4] Add admin route path constants in `../client-v2/src/utils/constants/paths.ts`: `ADMIN_TEAM_PROPERTIES = "${SETTINGS}/admin/team-properties"`, `ADMIN_MEMBER_PROPERTIES = "${SETTINGS}/admin/member-properties"`, `ADMIN_QUERY_RULES = "${SETTINGS}/admin/query-rules"`
- [x] T018 [US4] Add admin routes in `../client-v2/config/routes.ts`: three new route entries under the settings section, each using SettingsLayout as wrapper, pointing to the new page components (create placeholder pages that render "Coming soon" with portal admin check)
- [x] T019 [US4] Modify `../client-v2/src/layouts/SettingsLayout/index.tsx`: import `usePortalAdmin`, add admin-only menu items conditionally — "Team Properties", "Member Properties", "Query Rules" — visible only when `isPortalAdmin` is true. Follow existing pattern of `(condition && { key, label, href, icon }) || null` with `.filter()`

**Checkpoint**: User Story 4 complete — admin users see extra menu items, non-admins don't.

---

## Phase 5: User Story 2 — Portal Admin Management of Team & Member Properties (Priority: P2)

**Goal**: Portal admins can view all teams, edit team properties (including partition), and edit member properties on any team's members.

**Independent Test**: Sign in as portal admin → edit a team's partition → verify property saved. Set a member property → verify stored on member record.

### Tests for User Story 2

- [x] T020 [US2] Create StepCI tests for admin RPC handlers in `tests/workflows/access-controls/admin-properties.yaml`: test `list_all_teams` returns all teams (portal admin) and rejects non-admin; test `update_team_properties` merges properties and rejects non-admin; test `update_member_properties` merges properties and rejects non-admin; test `updateTeamSettings` accepts portal admin as alternative to team owner; **test that team owner calling `updateTeamSettings` cannot overwrite access-control keys (e.g., `partition`) — verify these keys are stripped from the owner's payload**; **test that direct Hasura mutation to `teams.settings` is rejected (UPDATE permission removed)**; **test that direct Hasura mutation to `auth.accounts.email` is rejected (UPDATE permission removed)**; **test that team members cannot read other members' `properties` via Hasura query**

### Implementation for User Story 2

- [x] T021 [P] [US2] Create `services/actions/src/rpc/listAllTeams.js`: import `isPortalAdmin` from `portalAdmin.js`; verify caller is portal admin; query all teams with member count aggregate; support `limit`/`offset` pagination; return `{ teams, total }`
- [x] T022 [P] [US2] Create `services/actions/src/rpc/updateTeamProperties.js`: import `isPortalAdmin`; verify caller is portal admin; accept `team_id` and `properties` (JSONB); fetch current team settings; merge properties (null values delete keys); execute `update_teams_by_pk` mutation with merged settings; return `{ success: true }`
- [x] T023 [P] [US2] Create `services/actions/src/rpc/updateMemberProperties.js`: import `isPortalAdmin`; verify caller is portal admin; accept `member_id` and `properties` (JSONB); fetch current member properties; merge (null deletes); execute `update_members_by_pk` mutation setting the `properties` column; return `{ success: true }`
- [x] T024 [US2] Modify `services/actions/src/rpc/updateTeamSettings.js`: (1) add alternative authorization path — if caller is not team owner, check `isPortalAdmin(userId)` and allow the update for portal admins; (2) **CRITICAL: On the owner path (non-portal-admin), strip access-control keys before writing** — fetch active `query_rewrite_rules` where `property_source = 'team'`, collect their `property_key` values, and remove those keys from the owner's settings update payload. This prevents team owners from accidentally overwriting or deleting security properties like `partition`. Portal admins bypass this restriction.
- [x] T025 [US2] Create `../client-v2/src/graphql/gql/admin.gql`: define GraphQL operations — `ListAllTeams` mutation (via action), `UpdateTeamProperties` mutation (via action), `UpdateMemberProperties` mutation (via action), `TeamMembersAdmin` query (members with properties, user display_name, account email, member_roles), `QueryRewriteRules` query (all rules). Run `yarn codegen` after
- [x] T026 [US2] Create `../client-v2/src/pages/AdminTeamProperties/index.tsx`: list all teams (using ListAllTeams mutation); for each team show name, member count, and editable key-value properties form; use Ant Design Table with inline editing or modal form; portal admin check via `usePortalAdmin` hook; on save call UpdateTeamProperties mutation. Follow RolesAndAccess page patterns (Card grid, modal form)
- [x] T027 [US2] Create `../client-v2/src/pages/AdminMemberProperties/index.tsx`: accept team_id (from URL or team selector); list team members with their properties; editable key-value form per member; on save call UpdateMemberProperties mutation; portal admin check. Follow Members page patterns
- [x] T028 [US2] Run `yarn codegen` in `../client-v2` to generate TypeScript types and URQL hooks for the new admin GraphQL operations

**Checkpoint**: User Story 2 complete — portal admins can manage team and member properties across all teams.

---

## Phase 6: User Story 3 — Query Rewriting Rules Configuration (Priority: P3)

**Goal**: Portal admins can create, edit, and delete query rewriting rules through a UI. Rules take effect within 60 seconds (cache TTL).

**Independent Test**: Create a rule mapping `entities.entity_id` to `member.entity_id` → set `entity_id` on a member → query entities as that member → verify only matching rows returned.

### Tests for User Story 3

- [x] T029 [US3] Create StepCI test for rule management in `tests/workflows/access-controls/query-rules.yaml`: test create/update/delete rule as portal admin; test rejection for non-admin; test non-`equals` operator is rejected (MVP restriction); test dimension containing `.` is rejected; test duplicate rule (same cube/dimension/source/key) is rejected; test invalid cube_name is rejected

### Implementation for User Story 3

- [x] T030 [US3] Create `services/actions/src/rpc/manageQueryRewriteRule.js`: import `isPortalAdmin`; verify caller; handle three actions — `create`: validate required fields (cube_name, dimension, property_source, property_key); validate dimension does not contain `.` (must be short name, not fully-qualified); validate operator is `equals` (only supported operator for MVP); validate `cube_name` against known cube names if possible (reject obvious typos — a typo here is fail-open); insert into `query_rewrite_rules` with created_by; `update`: validate id exists, validate fields if provided, update; `delete`: validate id exists, delete row. Return `{ success, rule_id }`
- [x] T031 [US3] Create `../client-v2/src/pages/AdminQueryRules/index.tsx`: list all rules (using QueryRewriteRules query from admin.gql); Ant Design Table showing cube_name, dimension, property_source, property_key, operator; add/edit/delete actions via modal form with dropdowns for property_source ('team'/'member') and operator (equals, notEquals, contains, etc.); on save call ManageQueryRewriteRule mutation; portal admin check
- [x] T032 [US3] Add `ManageQueryRewriteRule` mutation to `../client-v2/src/graphql/gql/admin.gql` and run `yarn codegen` in `../client-v2`

**Checkpoint**: User Story 3 complete — portal admins can configure which cubes get filtered and by which properties.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Final integration, edge cases, and validation

- [x] T033 [P] Handle edge case in `services/cubejs/src/utils/queryRewrite.js`: when a rule references a cube not present in the current query, it simply doesn't match (no error). Verify existing query behavior is unchanged when no rules exist. Note: invalid cube names are rejected at rule creation time (T030), so stale rules referencing deleted cubes are the only runtime case — these safely don't match
- [x] T034 [P] Handle edge case in `services/actions/src/auth/provision.js`: log warning when WorkOS token has no partition; verify team is created with empty settings (or settings without partition key)
- [x] T035 [P] Update `../client-v2/src/layouts/SettingsLayout/index.tsx`: ensure admin menu items have appropriate icons and i18n labels. Add translation keys to locale files if i18n is used
- [x] T036 Verify `../client-v2/src/graphql/gql/currentUser.gql` includes `members.properties` in the SubCurrentUser subscription so frontend gets real-time updates when member properties change. If not included, add it and run `yarn codegen`
- [x] T037 Run quickstart.md validation: execute all 6 verification steps from `specs/005-simple-access-controls/quickstart.md` against running Docker environment. Include: (1) multi-team edge case — verify user in multiple teams only sees data for the active team; (2) rule cache TTL — verify rule changes take effect within 60 seconds; (3) SC-003 time-to-effect — verify new rules apply on next query without restart

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 (migration must be applied first)
- **User Story 1 (Phase 3)**: Depends on Phase 2 — core provisioning + query rewriting
- **User Story 4 (Phase 4)**: Depends on Phase 2 — can run in parallel with US1
- **User Story 2 (Phase 5)**: Depends on Phase 2 + Phase 4 (needs portal admin UI gating)
- **User Story 3 (Phase 6)**: Depends on Phase 2 + Phase 4 (needs portal admin UI gating) + US1 (needs queryRewrite engine)
- **Polish (Phase 7)**: Depends on all user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Foundational only — no dependency on other stories
- **User Story 4 (P2)**: Foundational only — no dependency on other stories. Can run in parallel with US1
- **User Story 2 (P2)**: Depends on US4 (portal admin hooks and UI gating). Can start backend tasks (T021-T024) in parallel with US4
- **User Story 3 (P3)**: Depends on US4 (portal admin UI gating) and US1 (query rewrite engine must exist). Backend task T030 can start after Phase 2

### Within Each User Story

- Test tasks before implementation tasks (TDD per Constitution Principle III)
- Backend RPC handlers before frontend pages
- GraphQL operations (.gql) before page components
- `yarn codegen` after .gql changes, before page components that use generated hooks

### Parallel Opportunities

- T006 and T007 can run in parallel (different files in cubejs)
- T016 and T017 can run in parallel (different files in client-v2)
- T021, T022, T023 can all run in parallel (different RPC handler files)
- T033, T034, T035 can all run in parallel (different files, edge case handling)
- US1 and US4 can be worked on simultaneously after Phase 2

---

## Parallel Example: User Story 2

```bash
# Launch all backend RPC handlers in parallel:
Task: "Create listAllTeams.js in services/actions/src/rpc/listAllTeams.js"
Task: "Create updateTeamProperties.js in services/actions/src/rpc/updateTeamProperties.js"
Task: "Create updateMemberProperties.js in services/actions/src/rpc/updateMemberProperties.js"

# Then sequentially:
Task: "Create admin.gql in ../client-v2/src/graphql/gql/admin.gql"
Task: "Run yarn codegen"
Task: "Create AdminTeamProperties page"
Task: "Create AdminMemberProperties page"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (migrations + metadata)
2. Complete Phase 2: Foundational (portal admin util + CubeJS pipeline)
3. Complete Phase 3: User Story 1 (provisioning + query rewriting)
4. **STOP and VALIDATE**: Provision two users from different orgs, verify partition isolation
5. Deploy/demo if ready — data isolation is working

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 (provisioning + query rewriting) → **MVP: partition-based data isolation works**
3. Add US4 (portal admin detection + UI gating) → Admin users identified
4. Add US2 (team/member property management) → Admins can manage properties
5. Add US3 (query rules UI) → Admins can configure rules without code changes
6. Polish → Edge cases, validation, cleanup

### Parallel Team Strategy

With two developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: User Story 1 (backend: provisioning + queryRewrite)
   - Developer B: User Story 4 (frontend: admin hooks + UI gating)
3. Then:
   - Developer A: User Story 3 backend (manageQueryRewriteRule RPC)
   - Developer B: User Story 2 (all of it — backend RPCs + frontend pages)
4. Finally: US3 frontend, polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story should be independently completable and testable
- Commit after each task or logical group
- Stop at any checkpoint to validate story independently
- The 3 seed partition rules (T014) are critical for MVP — without them, queryRewrite has no rules to apply
- Run `./cli.sh hasura cli "migrate apply"` after T001-T002 before starting Phase 2
- Run `yarn codegen` in client-v2 after any .gql file changes
