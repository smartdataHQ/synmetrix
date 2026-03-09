# Quickstart: Simple Access Controls

**Branch**: `005-simple-access-controls` | **Date**: 2026-03-09

## Prerequisites

- Docker environment running (`./cli.sh compose up`)
- Client-v2 dev server running (`cd ../client-v2 && yarn dev`)
- WorkOS credentials configured in `.env` (`WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `WORKOS_REDIRECT_URI`)
- Redis running (for sessions)
- ClickHouse accessible (port-forward or Tailscale)

## Key Files to Modify

### Backend — Services

| File | Change |
|------|--------|
| `services/actions/src/auth/provision.js` | Accept and store partition from WorkOS token |
| `services/actions/src/auth/callback.js` | Extract partition from WorkOS auth result |
| `services/actions/src/rpc/updateTeamSettings.js` | Add portal admin authorization path |
| `services/actions/src/rpc/updateTeamProperties.js` | NEW — portal admin team property editor |
| `services/actions/src/rpc/updateMemberProperties.js` | NEW — portal admin member property editor |
| `services/actions/src/rpc/manageQueryRewriteRule.js` | NEW — CRUD for query rewriting rules |
| `services/actions/src/rpc/listAllTeams.js` | NEW — list all teams for admin view |
| `services/actions/src/utils/portalAdmin.js` | NEW — shared portal admin check utility |
| `services/cubejs/src/utils/queryRewrite.js` | Extend with rule-based row-level filtering |
| `services/cubejs/src/utils/defineUserScope.js` | Pass team properties and member properties into userScope |
| `services/cubejs/src/utils/dataSourceHelpers.js` | Extend userQuery to fetch member.properties |

### Backend — Hasura

| File | Change |
|------|--------|
| `services/hasura/migrations/NEXT/up.sql` | Add `properties` column to members, create `query_rewrite_rules` table |
| `services/hasura/metadata/tables.yaml` | Add `query_rewrite_rules` table, update `members` permissions |
| `services/hasura/metadata/actions.yaml` | Add new actions: update_team_properties, update_member_properties, manage_query_rewrite_rule, list_all_teams |
| `services/hasura/metadata/actions.graphql` | Add input/output types for new actions |

### Frontend — Client-v2

| File | Change |
|------|--------|
| `src/utils/constants/paths.ts` | Add admin route paths |
| `config/routes.ts` | Add admin routes |
| `src/layouts/SettingsLayout/index.tsx` | Add admin-only menu items (email domain check) |
| `src/pages/AdminTeamProperties/index.tsx` | NEW — team properties management page |
| `src/pages/AdminMemberProperties/index.tsx` | NEW — member properties management page |
| `src/pages/AdminQueryRules/index.tsx` | NEW — query rewriting rules management page |
| `src/graphql/gql/admin.gql` | NEW — admin-specific GraphQL operations |
| `src/hooks/usePortalAdmin.ts` | NEW — hook to check portal admin status |

## Verification Steps

1. **Provisioning**: Sign in via WorkOS with a token containing partition → verify team created with partition in settings
2. **Team Properties**: Sign in as `@snjallgogn.is` → navigate to admin team properties → edit a team's partition → verify change saved
3. **Member Properties**: As admin → set `entity_id` on a member → verify property stored on member record
4. **Query Rewriting**: As admin → create rule (semantic_events, partition, team, partition, equals) → query as a team member → verify partition filter applied
5. **Secure Default**: Remove a team's partition → query semantic_events → verify empty results
6. **Non-Admin Gate**: Sign in as non-admin → verify admin sections not visible → attempt direct API call → verify 403
