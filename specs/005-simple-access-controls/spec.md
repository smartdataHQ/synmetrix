# Feature Specification: Simple Access Controls

**Feature Branch**: `005-simple-access-controls`
**Created**: 2026-03-09
**Status**: Draft
**Input**: User description: "Simple Access Controls"

## Clarifications

### Session 2026-03-09

- Q: When a query rewriting rule references a property not set on the team/member, what happens? → A: Block all data (return empty results). Secure by default — no data leaks when a required property is missing.
- Q: Are query rewriting rules global or per-team? → A: Global templates scoped by cube. Rules apply universally; when a query involves a specific cube, matching rules for that cube inject filters using the querying user's team/member property values. Rules must align with Cube.js queryRewrite best practices (filter by cube member).
- Q: Can portal admins bypass query filtering to see cross-team data? → A: No bypass. Portal admins are filtered like everyone else. They can adjust their own team/member properties if they need different access.
- Q: Can portal admins create arbitrary property keys on teams/members? → A: Yes, free-form key-value pairs. It is up to query rewriting rules to reference them or not; unused keys are harmless.

## Out of Scope

- **Operators beyond `equals`**: The MVP supports only the `equals` operator for query rewriting rules. Additional operators (`notEquals`, `contains`, `gt`, etc.) may be added in a future iteration after type safety is established.
- **Datasource-scoped rules**: Rules are global by cube name. In a multi-datasource environment where different datasources have cubes with the same name, a global rule applies to all of them. Datasource-specific rule scoping may be added in a future iteration.

## Terminology

> **Portal admin** vs **team admin**: These are distinct concepts. A "portal admin" (also called "platform admin") is a system-wide role identified by the `@snjallgogn.is` email domain — they manage access controls across all teams. A "team admin" is a per-team role (the `admin` value in `member_roles.team_role`) — they manage their own team's datasources and members. Portal admins are NOT exempt from data filtering. Team admins/owners are NOT exempt from data filtering either — the existing early return bypass in `queryRewrite.js` for `owner`/`admin` roles MUST be removed as part of this feature.

> **Team properties** vs **team settings**: Team properties used for access control (e.g., `partition`) are stored in the existing `teams.settings` JSONB column but are protected — only portal admins can modify them. Team owners can continue to modify operational settings (e.g., `internal_tables`) through the existing `updateTeamSettings` handler, but that handler MUST strip or reject writes to access-control keys (any key referenced by an active `query_rewrite_rule` with `property_source = 'team'`).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Team Provisioning with Partition (Priority: P1)

A new user signs in via WorkOS. The authentication token includes a `partition` value. The system provisions the user into a team (team name derived from email domain per existing logic) and stores the partition as a team property in `team.settings`. If the team already exists (another user from the same email domain), the user is added as a member and inherits the team's partition property. All subsequent Cube.js API queries for this user are automatically filtered by the team's partition — the user only sees data belonging to their team. SQL API requests are blocked for teams with active query rewrite rules (see FR-019).

**Why this priority**: Without partition-based data isolation, teams would see each other's data. This is the foundational access control mechanism that all other stories depend on.

**Independent Test**: Can be tested by signing in two users from different organizations and verifying each only sees their own team's data in query results against `semantic_events`, `data_points`, and `entities`.

**Acceptance Scenarios**:

1. **Given** a new user `user@acme.com` signs in with a WorkOS token containing partition "acme-corp", **When** the system provisions the user, **Then** a team named "acme.com" is created (per existing email-domain logic), with `partition = "acme-corp"` stored in `team.settings`, and the user is assigned as owner.
2. **Given** a team "acme.com" already exists with partition "acme-corp", **When** a second user from `@acme.com` signs in, **Then** they are added as a member of the existing team and inherit the team's partition property for all queries.
3. **Given** a provisioned user queries the `semantic_events` table, **When** the query is executed, **Then** the system automatically injects a `WHERE partition = 'acme-corp'` filter (or equivalent) so the user only sees their team's data.
4. **Given** a provisioned user queries `data_points` or `entities`, **When** the query is executed, **Then** the same partition filter is applied to those tables as well.

---

### User Story 2 - Portal Admin Management of Team Properties (Priority: P2)

A portal administrator (any user whose email ends with `@snjallgogn.is`) can view and edit properties for any team in the system. These properties are arbitrary free-form key-value pairs — portal admins can create any key name they choose (e.g., `partition`, `entity_id`, `region`). Portal admins can also edit properties on individual team members (stored on the membership record, not the user record). These member-level properties can be used alongside team properties to create finer-grained query filters — for example, restricting a specific member to only see data for a particular entity.

**Why this priority**: Portal admins need to be able to correct, adjust, or customize access controls after teams are provisioned. This is the management layer that makes the system operational.

**Independent Test**: Can be tested by signing in as a portal admin, navigating to a team's properties, changing a value, and verifying that queries for that team's members now reflect the updated filter.

**Acceptance Scenarios**:

1. **Given** a user with email `admin@snjallgogn.is` is signed in, **When** they navigate to team management, **Then** they see a list of all teams in the system (not just their own).
2. **Given** a portal admin is viewing a team, **When** they edit the team's partition property, **Then** the change is saved and all future queries for that team's members use the updated partition value.
3. **Given** a portal admin is viewing a team's members, **When** they add a property to a specific member (e.g., `entity_id = "12345"`), **Then** that property is stored on the membership record and available for query filtering.
4. **Given** a user whose email does NOT end in `@snjallgogn.is`, **When** they attempt to access team property editing, **Then** the interface is not visible and the operation is rejected.
5. **Given** a portal admin creates a new property key `region` on a team, **When** the property is saved, **Then** it is stored as a free-form key-value pair and available for future query rewriting rules to reference.

---

### User Story 3 - Query Rewriting Rules Configuration (Priority: P3)

A portal administrator can define and manage query rewriting rules through a dedicated interface. Each rule maps a team or member property to a WHERE clause filter applied to specific data cubes (tables). For example, a rule might say: "For the `semantic_events` cube, filter by `partition` using the team's `partition` property." Rules are global templates — they apply to all teams universally, but the filter values come from each team's or member's own properties. Rules are scoped by cube: when a query involves a specific cube (via its dimensions, measures, or joins), matching rules for that cube inject the appropriate filters. This ensures data isolation without requiring changes to the data models themselves.

**Why this priority**: While the partition filter (Story 1) provides the baseline isolation, configurable rules allow the system to evolve — adding new filtered tables, new filter dimensions, or member-level filters — without code changes.

**Independent Test**: Can be tested by creating a rule that filters `semantic_events` by a member property, then running a query as that member and verifying the filter is applied in the results.

**Acceptance Scenarios**:

1. **Given** a portal admin opens the query rewriting rules interface, **When** they create a new rule specifying cube `semantic_events`, column `partition`, and source `team.partition`, **Then** the rule is saved and takes effect for all subsequent queries against that cube.
2. **Given** a rule exists mapping `entities.entity_id` to `member.entity_id`, **When** a member with `entity_id = "12345"` queries the `entities` cube, **Then** the query results only include rows where `entity_id = '12345'`.
3. **Given** a rule exists but the referenced property is not set on the team or member, **When** a query is executed, **Then** the system blocks all data for that cube (returns empty results) to prevent unfiltered access.
4. **Given** a non-portal-admin user, **When** they attempt to access the query rewriting rules interface, **Then** the interface is not visible and any direct attempts to modify rules are rejected.
5. **Given** multiple rules exist for the same cube, **When** a query is executed, **Then** all applicable rules are combined (AND logic) so that all filters are enforced simultaneously.

---

### User Story 4 - Portal Admin Identification and UI Gating (Priority: P2)

The system recognizes users with email addresses ending in `@snjallgogn.is` as portal administrators. These users see additional navigation items and management interfaces that are hidden from regular users. Portal admin status is determined by email domain — it is not a role that can be assigned or removed. The admin-only sections include: team property management (all teams), member property management, and query rewriting rule configuration. Portal admins are NOT exempt from data filtering — they see the same filtered data as other users based on their own team and member properties.

**Why this priority**: The admin concept is required for Stories 2 and 3 to function. Without identifying who is an admin, the management interfaces cannot be properly gated.

**Independent Test**: Can be tested by signing in with an `@snjallgogn.is` email and verifying admin UI elements appear, then signing in with a different domain and verifying they do not.

**Acceptance Scenarios**:

1. **Given** a user with email `user@snjallgogn.is` is signed in, **When** the application loads, **Then** the navigation includes admin-only sections for team properties, member properties, and query rewriting rules.
2. **Given** a user with email `user@example.com` is signed in, **When** the application loads, **Then** no admin-only sections are visible.
3. **Given** a portal admin is viewing the system, **When** they access any admin-only page, **Then** the backend verifies their email domain before processing the request (not just frontend hiding).
4. **Given** a portal admin queries data, **When** query rewriting rules exist, **Then** the admin's queries are filtered using their own team/member properties — no bypass or exemption.

---

### Edge Cases

- What happens when a WorkOS token does not include a partition value? The system should still provision the user and team but log a warning. The team is created without a partition, and queries against cubes with partition rules will return empty results (secure by default) until a portal admin sets one.
- What happens when a portal admin deletes a team's partition property? Queries for that team's members against cubes with partition rules will return empty results (secure by default), unless no rules reference that property.
- What happens when a member belongs to multiple teams with different partitions? The selected datasource determines the team scope. `defineUserScope.js` resolves the datasource → team → member link, so the member's properties and team's properties from that specific membership are used. Only properties for the active datasource's team apply.
- What happens when a query rewriting rule references a cube that doesn't exist in the current data model? The rule is rejected on save with a validation error. The `manageQueryRewriteRule` handler should validate `cube_name` against known cube names when possible. At query time, if a rule references a cube not in the query, it is simply not matched (no error, no filtering for that rule).
- What happens when two portal admins edit the same team's properties simultaneously? Standard last-write-wins behavior; no conflict resolution is required.
- What happens when a portal admin creates a property key that no rule references? The property is stored but has no effect on queries. It remains available for future rules.
- What happens when a team owner tries to modify the `partition` property via `updateTeamSettings`? The owner path strips or rejects writes to access-control keys (any key referenced by an active `query_rewrite_rule` with `property_source = 'team'`). Only portal admins can modify these keys via `updateTeamProperties`.
- What happens when a user queries data via the SQL API (`runSql`)? The REST SQL endpoint (`/api/v1/run-sql`) checks whether the user's team has active query rewrite rules and rejects the request with 403 if so (FR-019). Native SQL port access (13306/15432) is gated by explicit `sql_credentials` entries — teams with active rules should not have credentials provisioned.

## Requirements *(mandatory)*

### Functional Requirements

**Team Properties**

- **FR-001**: System MUST store arbitrary free-form key-value properties on team records. Portal admins can create any key name. The `partition` property MUST be populated from the WorkOS authentication token during team provisioning (when present in the token).
- **FR-002**: System MUST make team properties available in the query execution context so they can be referenced by query rewriting rules.
- **FR-002a**: Team owners MUST NOT be able to modify access-control properties (keys referenced by active `query_rewrite_rules` with `property_source = 'team'`) through the `updateTeamSettings` handler. Only portal admins can modify these keys via `updateTeamProperties`.

**Member Properties**

- **FR-003**: System MUST store arbitrary free-form key-value properties on membership records (the link between a user and a team, not on the user record itself). Portal admins can create any key name.
- **FR-004**: System MUST make member properties available in the query execution context alongside team properties.

**Query Rewriting**

- **FR-005**: System MUST support configurable query rewriting rules that inject WHERE clause filters into Cube.js API queries against specific cubes. Rules are global templates scoped by cube name. (SQL API is out of scope — see "Out of Scope".)
- **FR-006**: Each query rewriting rule MUST specify: the target cube, the target dimension (short name within the cube, validated to not contain `.`), the source property (`team` or `member`), and the filter operator. For MVP, only the `equals` operator is supported.
- **FR-007**: System MUST apply all matching rules for a given query, combining them with AND logic. A rule matches when its target cube appears in the query's dimensions or measures (extracted by splitting fully-qualified member names on `.`). If ANY cube in the query is blocked (missing required property), the ENTIRE query MUST be blocked (return empty results), not just the blocked cube's portion — this prevents partial data leaks in multi-cube queries.
- **FR-008**: System MUST apply query rewriting rules to at minimum these cubes: `semantic_events`, `data_points`, and `entities`.
- **FR-009**: System MUST apply query rewriting filters to all users regardless of team role (owner, admin, member). The existing early return bypass in `queryRewrite.js` for owner/admin roles MUST be removed. Portal admins (email-based) are also not exempt from data filtering.
- **FR-010**: When a query rewriting rule references a property that is not set on the team or member, the system MUST block the entire query (return empty results for all cubes in the query, not just the affected cube). Secure by default — no data leaks from missing properties, and no partial results from joined queries.

**Portal Admin**

- **FR-011**: System MUST identify portal administrators by email domain — any user whose email ends with `@snjallgogn.is` is a portal admin. This is safe only because FR-017 removes the ability for users to change their own email. Portal admin detection queries the email from `auth.accounts` on the server side (not from JWT claims or user-editable fields).
- **FR-012**: Only portal administrators MUST be able to view and edit team properties for any team.
- **FR-013**: Only portal administrators MUST be able to view and edit member properties for any team's members.
- **FR-014**: Only portal administrators MUST be able to create, edit, and delete query rewriting rules.
- **FR-015**: Portal admin status MUST be enforced on both frontend (UI gating) and backend (request authorization).

**Provisioning**

- **FR-016**: System MUST handle provisioning gracefully when no partition is present in the WorkOS token — team is created without a partition property, and queries against cubes with partition rules will return empty results until a portal admin sets the property.

**Security Hardening**

- **FR-017**: System MUST remove Hasura UPDATE permission on `auth.accounts.email` for role `user`. Currently users can change their own email via direct Hasura mutation, which would allow self-escalation to portal admin by changing email to `@snjallgogn.is`. Email changes must go through WorkOS only.
- **FR-018**: System MUST remove Hasura UPDATE permission on `teams.settings` for role `user` (currently allows team owners to directly mutate settings via GraphQL, bypassing the RPC handler's access-control key protection). All settings changes MUST go through the `updateTeamSettings` or `updateTeamProperties` RPC handlers.
- **FR-019**: System MUST block SQL API access (`/api/v1/run-sql` REST endpoint) for users whose active datasource belongs to a team with active query rewrite rules. The `runSql` route handler must check whether the user's team has applicable rules and reject the request with a 403 if so. Native SQL ports (13306/15432) are gated by `sql_credentials` table entries and are lower risk but should not be provisioned for teams with active rules.
- **FR-020**: The `members.properties` column MUST NOT be added to the team-wide Hasura SELECT permission for role `user`. Member properties are access-control metadata visible only to portal admins (via RPC action) and to the CubeJS service (via admin-role GraphQL). Other team members must not be able to read each other's properties.

### Key Entities

- **Team Properties**: Arbitrary free-form key-value pairs associated with a team. Portal admins can create any key name. The `partition` property is the primary use case, controlling which subset of data the team can access. Properties are set during provisioning and editable by portal admins. Unused properties (not referenced by any rule) are harmless.
- **Member Properties**: Arbitrary free-form key-value pairs associated with a specific membership (user-in-team). Portal admins can create any key name. Allow per-member data filtering within a team. Editable only by portal admins.
- **Query Rewriting Rule**: A global configuration entry that maps a team or member property to a WHERE clause filter on a specific cube/dimension. Rules are scoped by cube name — they activate when a query involves the target cube. Multiple rules for the same cube are combined with AND logic. Managed by portal admins.
- **Portal Admin**: A user identified by their `@snjallgogn.is` email domain. Has elevated permissions to manage team properties, member properties, and query rewriting rules across all teams. Subject to the same data filtering as all other users — no bypass.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users provisioned through WorkOS can only see data matching their team's partition — verified by querying `semantic_events`, `data_points`, and `entities` and confirming zero rows from other partitions appear.
- **SC-002**: Portal admins can update a team's partition property and see the change reflected in query results for that team's members within the same session (no logout/login required).
- **SC-003**: Portal admins can create a query rewriting rule and verify it takes effect within 60 seconds (rule cache TTL) — no service restart or redeployment needed.
- **SC-004**: Non-admin users see no admin-only UI elements and receive authorization errors if they attempt to call admin-only operations directly.
- **SC-005**: Member-level properties can be set by a portal admin and used in query rewriting rules to further restrict a specific member's data access within their team.
- **SC-006**: When a required property is missing, queries return empty results rather than unfiltered data — verified by removing a team's partition property and confirming zero rows returned.
- **SC-007**: Portal admins querying data are subject to the same filtering rules as regular users — verified by comparing query results between admin and non-admin users with identical team/member properties.

## Assumptions

- The WorkOS authentication result includes a `partition` value. The extraction path is `authResult.organizationId` or a custom claim — the exact path MUST be confirmed with the WorkOS integration before implementation begins. The callback handler (`callback.js`) will try `authResult.partition || authResult.organizationId || null` and the confirmed path must be documented in the code.
- The three target tables (`semantic_events`, `data_points`, `entities`) all have a `partition` column (or equivalent) that can be filtered on.
- The existing `team.settings` field (which already stores `partition` and `internal_tables`) is the natural location for team properties, or a closely related structure.
- Query rewriting rules use the `equals` operator for MVP. Additional operators may be added in future iterations.
- Portal admin identification by email domain is sufficient for the current user base and does not require a more formal role assignment mechanism.
- The consumer domain blocklist in provisioning (gmail.com, outlook.com, etc.) continues to function as before — consumer domain users get personal teams with whatever partition their token carries.
- The existing baked-in partition filtering in `cubeBuilder.js` (which injects `WHERE partition = '...'` at cube generation time for `internal_tables`) coexists with the new runtime query rewriting rules. Both mechanisms are safe to run together (double-filtering is redundant, not conflicting). The baked-in approach is authoritative for cube model generation; runtime rules are authoritative for query-time filtering. The baked-in approach may be deprecated in a future iteration.
- Only team-level properties are included in the `dataSourceVersion` cache hash. Member-level properties are NOT included in the hash — they are applied as runtime query filters only. This prevents cache over-fragmentation: all members of the same team share cache buckets, with member-specific filters applied at query time.
