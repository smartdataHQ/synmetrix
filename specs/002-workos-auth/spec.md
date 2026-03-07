# Feature Specification: WorkOS Authentication

**Feature Branch**: `002-workos-auth`
**Created**: 2026-03-07
**Status**: Draft
**Input**: Replace Synmetrix login logic with WorkOS AuthKit, matching the cxs2/FraiOS authentication pattern.

## Clarifications

### Session 2026-03-07

- Q: How should existing users be handled? → A: Fresh start -- no migration from hasura-backend-plus. All users are provisioned via JIT on first WorkOS sign-in. The same WorkOS account used by cxs2/FraiOS is shared with Synmetrix (secrets moved from cxs2 .env).
- Q: How should email domain to team mapping work? → A: Auto-create team if no team exists for the user's email domain, then add the user to it. If a team already exists for the domain, add the user to that team.
- Q: What session duration and behavior? → A: 24-hour sliding window TTL, synced with WorkOS session TTL when available -- matching cxs2's exact session management pattern.
- Q: What is the sign-out scope? → A: Current session only by default, with optional "sign out everywhere" capability (matching cxs2's `?revoke_all=true` pattern).
- Q: General design principle → A: cxs2/FraiOS is the definitive blueprint for all auth behavior. When a design decision arises that cxs2 already answers, adopt the cxs2 pattern directly.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign In via WorkOS (Priority: P1)

A user navigates to the Synmetrix login page and is presented with sign-in options (email/SSO, social providers like Google, GitHub, LinkedIn). Clicking any option redirects them to the WorkOS-hosted authentication UI. After authenticating, they are redirected back to Synmetrix with an active session and land on the main application page.

**Why this priority**: Authentication is the gateway to the entire application. Without sign-in, no other feature is accessible.

**Independent Test**: Can be fully tested by navigating to `/signin`, completing the WorkOS flow, and verifying the user lands on the application with a valid session and can make authenticated GraphQL requests.

**Acceptance Scenarios**:

1. **Given** a user is not signed in, **When** they visit a protected page, **Then** they are redirected to the sign-in page.
2. **Given** a user is on the sign-in page, **When** they click "Continue with Google" (or another provider), **Then** they are redirected to the WorkOS-hosted authentication UI.
3. **Given** a user completes authentication at WorkOS, **When** they are redirected back via the callback URL, **Then** a session is created and they are redirected to the main application page.
4. **Given** a user has an active session, **When** they make a GraphQL request, **Then** the request includes valid authorization headers and succeeds.

---

### User Story 2 - Sign Out (Priority: P1)

A signed-in user clicks "Sign Out" and their current session is terminated. They are redirected to the sign-in page and can no longer access protected resources. An optional "sign out everywhere" action revokes all sessions across devices.

**Why this priority**: Sign-out is essential for security and multi-user scenarios. Tied directly to sign-in.

**Independent Test**: Sign in, then sign out and verify session is invalidated and protected pages redirect to sign-in.

**Acceptance Scenarios**:

1. **Given** a user is signed in, **When** they click "Sign Out", **Then** their current session is destroyed and they are redirected to the sign-in page.
2. **Given** a user has signed out, **When** they attempt to access a protected page, **Then** they are redirected to the sign-in page.
3. **Given** a user chooses "sign out everywhere", **When** the action completes, **Then** all their sessions across all devices are revoked.

---

### User Story 3 - Session Persistence and Token Refresh (Priority: P1)

A user who authenticated earlier returns to the application (e.g., refreshes the page or opens a new tab). Their session is still valid (24-hour sliding window) and they are not asked to sign in again. Each request extends the session TTL.

**Why this priority**: Without session persistence, users would need to re-authenticate on every page load, making the application unusable.

**Independent Test**: Sign in, close the tab, reopen the application, and verify the user is still authenticated and can make requests.

**Acceptance Scenarios**:

1. **Given** a user has an active session, **When** they refresh the page, **Then** they remain signed in.
2. **Given** a user's access token has expired but their session is still valid, **When** they make a request, **Then** the token is refreshed automatically and the request succeeds.
3. **Given** a user's session has expired (24 hours of inactivity), **When** they attempt to access the application, **Then** they are redirected to the sign-in page.

---

### User Story 4 - Sign Up and Team Assignment (Priority: P2)

A new user who does not have an account can create one through the WorkOS-hosted sign-up flow. After completing registration, they are authenticated, a local user record is created via JIT provisioning, and they are assigned to a team based on their email domain (auto-creating the team if it doesn't exist).

**Why this priority**: New user onboarding is important but secondary to existing user sign-in for initial release.

**Independent Test**: Navigate to sign-up, complete the WorkOS registration flow, verify the user is created, assigned to the correct team, and lands in the application.

**Acceptance Scenarios**:

1. **Given** a user is on the sign-in page, **When** they click "Create Account", **Then** they are directed to the WorkOS sign-up flow.
2. **Given** a user completes WorkOS registration with email `user@example.com`, **When** they are redirected back, **Then** a local user record is created and they are added to the team for `example.com` (created if it doesn't exist).
3. **Given** a user signs in and a team already exists for their email domain, **When** JIT provisioning runs, **Then** they are added to the existing team.

---

### Edge Cases

- What happens when the WorkOS callback receives an error (e.g., user denies consent)? The user should see a clear error message on the sign-in page.
- What happens when a user's WorkOS account exists but no matching local user record exists? A local user record should be created automatically (JIT provisioning) and the user assigned to a team by email domain.
- What happens when the backend auth service is unavailable during callback? The user should see a user-friendly error and be able to retry.
- What happens when a user tries to access the callback URL directly without going through WorkOS? They should be redirected to the sign-in page.
- What happens when a user's email domain doesn't match any existing team? A new team is auto-created for that domain and the user is added to it.
- What happens when a user signs in with a consumer email (gmail.com, outlook.com, etc.)? They get a personal workspace (team named after their full email or a personal identifier) instead of being grouped with all other gmail.com users.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST authenticate users via WorkOS AuthKit (shared WorkOS account with cxs2/FraiOS), supporting email/SSO and social providers (Google, GitHub, LinkedIn).
- **FR-002**: System MUST handle the OAuth callback by exchanging the authorization code for user identity information and creating a server-side session.
- **FR-003**: System MUST mint JWT tokens compatible with Hasura's existing claim structure (`hasura` namespace with `x-hasura-user-id` and `x-hasura-role`) so that existing Hasura permissions, CubeJS auth, and URQL client continue to work unchanged.
- **FR-004**: System MUST provide a token refresh mechanism so the frontend can obtain fresh JWTs without requiring the user to re-authenticate.
- **FR-005**: System MUST terminate the current session on sign-out, invalidating both the local session and the WorkOS session. An optional "revoke all" parameter MUST terminate all user sessions.
- **FR-006**: System MUST automatically create local user records for new WorkOS users on first sign-in (JIT provisioning).
- **FR-007**: System MUST assign JIT-provisioned users to a team based on their email domain, auto-creating the team if none exists for that domain.
- **FR-008**: The sign-in page MUST replace the current email/password form with WorkOS-based options (social providers, SSO, email).
- **FR-009**: System MUST redirect unauthenticated users to the sign-in page when they attempt to access protected routes.
- **FR-010**: The frontend MUST continue to send Hasura-compatible authorization headers on all GraphQL requests.
- **FR-011**: System MUST validate callback redirect URLs to prevent open redirect attacks.
- **FR-012**: Sessions MUST use a 24-hour sliding window TTL, with TTL reset on each token refresh request (`GET /auth/token`). Note: GraphQL requests go directly to Hasura and do not pass through the Actions service, so only explicit token fetches extend the session.
- **FR-013**: System MUST reject JIT team assignment for consumer email domains (gmail.com, outlook.com, hotmail.com, yahoo.com, etc.) by creating a personal workspace instead of a shared domain-based team. This prevents unrelated users from sharing a tenant.
- **FR-014**: System MUST persist the WorkOS user ID (`workos_user_id`) alongside the local user record, and use it as the primary identity key for JIT provisioning lookups. Email-based lookup is a fallback only, preventing identity breakage if a user changes their email in WorkOS.
- **FR-015**: JWT tokens minted by the backend MUST have a short TTL (~15 minutes), independent of the 24-hour session TTL. This limits the window of exposure if a token is leaked, since JWTs are not revocable at the Hasura/CubeJS layer.

### Key Entities

- **User**: Represents an authenticated person. Linked to a WorkOS user ID (persisted as `workos_user_id`). Has local attributes (email, role) and a Hasura-compatible user ID used for row-level security. Created via JIT provisioning on first sign-in.
- **Team**: Organizational unit defined by email domain. Users are auto-assigned to teams based on their email domain. Auto-created if no team exists for a given domain. Consumer domains (gmail.com, outlook.com, etc.) are excluded — users with consumer emails get a personal workspace instead.
- **Session**: Server-side record linking a session identifier to a user. Stores the user's identity, access token, and metadata. Referenced by an HTTP-only cookie. 24-hour sliding window TTL.
- **JWT Token**: Short-lived token containing Hasura claims. Minted by the backend auth service from session data. Used by the frontend for GraphQL and CubeJS API requests.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can complete the full sign-in flow (click sign-in to landing on the application) in under 10 seconds.
- **SC-002**: All existing GraphQL queries, mutations, and subscriptions continue to work without modification after the auth migration.
- **SC-003**: Session persistence works across page refreshes and new tabs without re-authentication.
- **SC-004**: Sign-out fully terminates the session -- no stale tokens allow continued access.
- **SC-005**: New users signing in for the first time are automatically provisioned, assigned to a team by email domain, and can use the application immediately.
- **SC-006**: The hasura-backend-plus service is no longer required for login/logout authentication (can be removed from the auth flow). Note: other hasura-backend-plus features (e.g., magic link invitations used by `inviteTeamMember.js`) are out of scope for this feature and will be addressed separately.

## Assumptions

- The same WorkOS account used by cxs2/FraiOS is shared with Synmetrix. WorkOS secrets (API key, client ID, redirect URI) are moved from cxs2's .env to Synmetrix and client-v2 environment files.
- There are no existing hasura-backend-plus users to migrate. All users will be provisioned fresh via WorkOS JIT.
- The existing Hasura JWT verification mechanism (shared secret, HS256) will be preserved -- the backend will mint JWTs using the same secret and claim structure.
- The Actions service (Express, port 3000) will host the new auth endpoints, since it is already an Express server on the port registered with WorkOS.
- Redis will be introduced for server-side session management, following the cxs2 pattern.
- The CubeJS service's `checkAuth.js` does not need modification -- it will continue to verify JWTs with the same shared secret and extract claims from the `hasura` namespace.
- cxs2/FraiOS serves as the definitive blueprint for all auth behavior. Design decisions default to the cxs2 pattern.
