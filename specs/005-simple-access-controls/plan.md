# Implementation Plan: Simple Access Controls

**Branch**: `005-simple-access-controls` | **Date**: 2026-03-09 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/005-simple-access-controls/spec.md`

## Summary

Add configurable row-level data access controls to Synmetrix. Teams and members get arbitrary key-value properties (with `partition` as the primary use case). Global query rewriting rules map these properties to WHERE clause filters on specific cubes (`semantic_events`, `data_points`, `entities`). Portal administrators (users with `@snjallgogn.is` email) manage team/member properties and rules through a dedicated admin UI. Missing property values block data access (secure by default). The partition property is set automatically during WorkOS provisioning.

## Technical Context

**Language/Version**: JavaScript (ES modules), Node.js 18+
**Primary Dependencies**: Cube.js v1.6.x (CubeJS), Express 4.x (Actions), Hasura v2 (GraphQL), React 18 + Vite + Ant Design 5 (client-v2), URQL (GraphQL client), Zustand (state)
**Storage**: PostgreSQL (via Hasura), Redis (sessions), CubeStore (query cache)
**Testing**: StepCI (integration), Vitest (frontend)
**Target Platform**: Docker (Linux containers), browser (frontend)
**Project Type**: Web service (multi-service monorepo) + SPA frontend
**Performance Goals**: Query rewriting adds <10ms overhead (cached rule lookup). Rule changes take effect within 60 seconds (cache TTL).
**Constraints**: Must flow through existing CubeJS `queryRewrite` function. Must not break existing access_list field-level filtering. Must work with existing multi-tenancy (content-hashed security contexts). SQL API REST endpoint blocked for teams with active rules (prevents queryRewrite bypass). The existing owner/admin bypass in `queryRewrite` must be removed (all roles filtered by rules). The baked-in partition filtering in `cubeBuilder.js` coexists with runtime rules (baked-in is authoritative for model generation, runtime for query filtering). MVP uses `equals` operator only. Only team properties in cache hash (not member properties — prevents fragmentation). Hasura UPDATE on `auth.accounts.email` and `teams.settings` must be removed for role `user` (prevents self-escalation and settings bypass).
**Scale/Scope**: Tens of teams, hundreds of members, <50 rewriting rules.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | New RPC handlers follow existing Actions→Hasura pattern. CubeJS changes are internal to queryRewrite. Frontend changes are client-v2 only. No cross-service contract changes beyond new Hasura actions (versioned). |
| II. Multi-Tenancy First | PASS | Extends existing multi-tenancy. Team properties flow through `defineUserScope` → `buildSecurityContext` (existing pipeline). Query rewriting adds filters without bypassing cache isolation. Team properties included in security context hash ensures cache separation. |
| III. Test-Driven Development | PASS | StepCI tests required for new RPC actions. Integration tests for queryRewrite rule application. Frontend tests for admin UI gating. |
| IV. Security by Default | PASS | Missing properties → block data (empty results). Portal admin enforced on both frontend and backend. Email domain check is server-side, not JWT-dependent. All existing JWT validation unchanged. |
| V. Simplicity / YAGNI | PASS | Uses existing JSONB patterns (team.settings). One new table (query_rewrite_rules). No new abstractions — extends existing queryRewrite function. Free-form properties avoid premature schema design. |

### Post-Design Re-check

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Service Isolation | PASS | 4 new RPC handlers + 1 modified. Hasura actions are the contract. CubeJS internal changes only. |
| II. Multi-Tenancy First | PASS | Team properties added to security context hash via buildSecurityContext. Different property values → different cache buckets. |
| III. TDD | PASS | Test plan defined per contract in contracts/rpc-actions.md. |
| IV. Security by Default | PASS | Secure-by-default confirmed: missing property = block entire query. Portal admin check = email lookup, hardened by removing Hasura UPDATE on email. Settings bypass closed by removing Hasura direct UPDATE. SQL API blocked for secured teams. |
| V. Simplicity | PASS | No unnecessary abstractions. Rule cache is a simple Map with TTL. |

## Project Structure

### Documentation (this feature)

```text
specs/005-simple-access-controls/
├── spec.md
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/
│   └── rpc-actions.md   # Phase 1 output
├── checklists/
│   └── requirements.md
└── tasks.md             # Phase 2 output (via /speckit.tasks)
```

### Source Code (repository root)

```text
services/actions/src/
├── auth/
│   ├── callback.js          # MODIFIED — extract partition from WorkOS token
│   └── provision.js         # MODIFIED — pass partition to createTeam
├── rpc/
│   ├── updateTeamSettings.js    # MODIFIED — add portal admin auth path
│   ├── updateTeamProperties.js  # NEW
│   ├── updateMemberProperties.js # NEW
│   ├── manageQueryRewriteRule.js # NEW
│   └── listAllTeams.js          # NEW
└── utils/
    └── portalAdmin.js           # NEW — isPortalAdmin(userId) helper

services/cubejs/src/utils/
├── queryRewrite.js          # MODIFIED — add rule-based row filtering
├── defineUserScope.js       # MODIFIED — pass team/member properties
├── dataSourceHelpers.js     # MODIFIED — extend userQuery for member.properties
└── buildSecurityContext.js  # MODIFIED — include team properties in hash

services/hasura/
├── migrations/
│   └── {timestamp}_add_member_properties_and_query_rewrite_rules/
│       ├── up.sql           # NEW — add members.properties, create query_rewrite_rules
│       └── down.sql         # NEW — rollback
└── metadata/
    ├── tables.yaml          # MODIFIED — add query_rewrite_rules table, update members
    ├── actions.yaml         # MODIFIED — add 4 new actions
    └── actions.graphql      # MODIFIED — add input/output types

# Client-v2 (../client-v2)
src/
├── hooks/
│   └── usePortalAdmin.ts        # NEW
├── pages/
│   ├── AdminTeamProperties/     # NEW
│   ├── AdminMemberProperties/   # NEW
│   └── AdminQueryRules/         # NEW
├── graphql/gql/
│   └── admin.gql                # NEW
├── layouts/
│   └── SettingsLayout/index.tsx # MODIFIED — add admin menu items
└── utils/constants/
    └── paths.ts                 # MODIFIED — add admin paths
```

**Structure Decision**: Follows existing monorepo structure. New files are placed alongside existing patterns (RPC handlers in `rpc/`, pages in `pages/`, etc.). No new directories at the project root level.

## Complexity Tracking

No constitution violations to justify. All changes follow existing patterns.
