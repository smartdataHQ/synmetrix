# Feature Specification: On-Prem Services

**Feature Branch**: `012-onprem-services`
**Created**: 2026-06-10
**Status**: Draft
**Input**: User description: "On-Prem Services (cxs2 auth + synmetrix as test case for on-prem deployments of our solutions)"

## Overview

Customers can run our solutions (Synmetrix first, others later) on their own
infrastructure while we keep central control of identity and account standing.
The customer installation contains **no central-platform secrets**: users sign
in through our central platform, the installation verifies identity assertions
using public material that cannot forge them, and the installation
periodically confirms with the central platform that the customer's account is
active. A customer who stops being a customer loses the ability to sign in
within a bounded time window; a temporary central outage does not interrupt
the customer's work. Abler is the first customer and Synmetrix the first
packaged solution; the mechanisms are designed to be reused for every future
on-prem customer and solution.

Two standing constraints frame everything below:

1. **Our own hosted Synmetrix keeps working exactly as it does today.** Its
   sign-in flow, user provisioning, and operation are untouched by this
   feature; everything here activates only on instances explicitly configured
   as on-prem.
2. **The central platform is a configurable gateway, not a fixed address.**
   It is reachable today at one domain (app.fraios.dev) but may move (e.g.
   app.fraios.com, app.fraios.ai). Every reference an on-prem instance holds
   to the central platform is configuration, changeable in place — never a
   hardcoded location in the shipped software.

## Clarifications

### Session 2026-06-11

- Q: How do platform operators create/suspend/manage instance registrations
  in v1? → A: Data-tooling only — operators manage registry rows directly via
  the central platform's existing data tooling; the only new central surfaces
  are the status and sign-in handoff endpoints. An admin UI may layer on
  later without contract changes.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Customer user signs in via central authentication (Priority: P1)

An analyst at the customer opens the on-prem Synmetrix URL and clicks sign in.
They are briefly sent to our central platform, authenticate there (or are
recognized from an existing central session), and land back in the on-prem
application fully signed in. All user identities live in our central user
pool; the on-prem installation never stores or receives any credential or key
that could impersonate the central platform or other customers.

**Why this priority**: This is the core of the feature — without central
login that works secret-free on the customer's box, no on-prem delivery can
ship. It also enforces the business goal that every on-prem user is a known,
centrally-owned identity.

**Independent Test**: Deploy an on-prem instance with only its public
configuration (no central secrets), register it centrally, and complete a
sign-in round trip as a permitted user. Inspect the instance's configuration
and storage to confirm no central-platform secret is present.

**Acceptance Scenarios**:

1. **Given** a registered on-prem instance and a user whose email domain is on
   the instance's allowlist, **When** the user signs in via the central
   platform, **Then** they arrive back at the on-prem instance signed in, with
   a local account and team membership provisioned automatically.
2. **Given** a user already signed in to the central platform, **When** they
   sign in to the on-prem instance, **Then** no re-entry of credentials is
   required and the round trip completes in seconds.
3. **Given** a user whose email domain and organization are not permitted for
   this instance, **When** they complete central authentication, **Then** the
   on-prem instance refuses sign-in and shows an access-denied message.
4. **Given** an identity assertion issued for instance A, **When** it is
   presented to instance B, **Then** instance B rejects it.
5. **Given** an expired or tampered identity assertion, **When** it is
   presented to the instance, **Then** sign-in fails safely with no session
   created.
6. **Given** a signed-in user, **When** they use the application normally,
   **Then** no per-request traffic to the central platform occurs — the
   session is entirely local until it expires.

---

### User Story 2 - Account standing controls instance operation (Priority: P2)

The on-prem installation periodically confirms with our central platform that
the customer's account is active. While confirmation succeeds, everything
works. If we suspend the account, the installation stops accepting sign-ins
and ends active sessions within a bounded window. If our central platform is
temporarily unreachable, the installation keeps working unchanged for a grace
period before degrading.

**Why this priority**: This is the commercial tether — customers may run our
software on their hardware only while they hold an active account. Without
it, shipping on-prem means losing all leverage after delivery.

**Independent Test**: Run an instance with an active registration, verify
normal operation; suspend the registration centrally and verify sign-ins stop
within the propagation window; block network access to the central platform
and verify operation continues until the grace period lapses.

**Acceptance Scenarios**:

1. **Given** an active customer account, **When** the instance performs its
   periodic status check, **Then** the check succeeds and operation continues
   uninterrupted.
2. **Given** a suspended customer account, **When** the next status check
   occurs, **Then** new sign-ins are refused immediately and existing
   sessions end at their next renewal, both within the propagation window
   (default: hours, not days).
3. **Given** the central platform is unreachable, **When** users sign in or
   work during the grace period (default 72 hours), **Then** behavior is
   indistinguishable from normal operation.
4. **Given** the grace period has fully lapsed without a successful check,
   **When** a user attempts to sign in, **Then** the instance refuses with a
   clear "contact your administrator" message, and resumes automatically once
   a status check succeeds again.
5. **Given** a running instance, **When** the operator views the central
   platform's instance registry, **Then** they see the instance's last
   check-in time and reported software version.

---

### User Story 3 - Operator installs a self-contained on-prem bundle (Priority: P3)

A customer administrator receives the install bundle and registry
credentials, fills in a documented configuration file (their domain, locally
generated secrets, the login allowlist, their instance credential), and brings
the full stack up on a single host or on their Kubernetes cluster. Everything
the product needs is included except the analytics databases they connect
themselves.

**Why this priority**: Packaging already exists in draft form; the remaining
work is wiring the new authentication and status mechanisms into it. It is
the delivery vehicle for stories 1 and 2.

**Independent Test**: From a clean machine with only container runtime and
registry credentials, follow the install document to a working instance and a
successful first sign-in.

**Acceptance Scenarios**:

1. **Given** the documented bundle and valid registry credentials, **When**
   the administrator completes configuration and starts the stack, **Then**
   all services come up healthy and the sign-in page is reachable on their
   domain.
2. **Given** the same bundle, **When** the administrator inspects its
   configuration templates, **Then** every secret value is either generated
   locally by them or identifies only their own instance — none grants access
   to central systems or other customers.
3. **Given** a new product release, **When** the administrator updates the
   image version and re-runs the documented upgrade step, **Then** the
   instance upgrades without reinstalling.

---

### User Story 4 - Additional on-prem services reuse the instance's sign-in (Priority: P4)

Some solution components we deploy alongside Synmetrix have no login of their
own. Within the customer installation, those components accept the sessions
and tokens issued by the instance's own authentication, so a user signs in
once per instance regardless of how many components are deployed.

**Why this priority**: Needed for the broader "our solutions on-prem" goal,
but no concrete second component ships in this feature — the mechanism and
its documentation are the deliverable.

**Independent Test**: Deploy a sample/stub service configured with the
instance's shared verification material and confirm it accepts a signed-in
user's token and rejects an expired or foreign one.

**Acceptance Scenarios**:

1. **Given** a signed-in user and a co-deployed component configured for the
   instance's trust domain, **When** the user's client calls that component,
   **Then** the call is accepted without a separate sign-in.
2. **Given** a token from a different instance or an expired token, **When**
   presented to the component, **Then** it is rejected.

---

### Edge Cases

- Central platform reachable but the instance's registration was deleted (not
  merely suspended): sign-ins refuse with the same administrator-facing
  message; nothing crashes.
- A user is removed from the central user pool while holding an active local
  session: the session ends at its next renewal; no new sign-in is possible.
- The allowlist is tightened while a now-excluded user holds a session: the
  user is refused at next sign-in; session renewal policy treats them as any
  other session until expiry.
- Identity assertion replay: an assertion already used to create a session
  cannot be used again.
- Clock skew between central platform and instance: tolerated within a small
  bound; gross skew produces a clear operator-facing error rather than silent
  sign-in failures.
- The instance's status credential leaks: it can be revoked centrally and
  reissued without reinstalling; the credential grants nothing beyond
  reporting/checking that one instance's status.
- Two instances registered for the same customer: each has its own identity,
  allowlist, and standing; suspending one does not affect the other.
- Browser blocks third-party redirects/cookies: the sign-in flow uses
  top-level navigation only and completes regardless.
- The central gateway moves to a new domain: instances updated with the new
  address resume sign-ins and status checks without reinstalling; instances
  not yet updated keep operating on their grace window, and signed-in users
  are unaffected throughout.

## Requirements *(mandatory)*

### Functional Requirements

**Central authentication**

- **FR-001**: All user identities for on-prem installations MUST be held in
  the central platform's single user pool; on-prem installations MUST NOT
  operate their own credential store for sign-in.
- **FR-002**: The central platform MUST be the sole issuer of identity
  assertions for on-prem sign-in, and each assertion MUST be bound to exactly
  one registered instance.
- **FR-003**: On-prem instances MUST be able to verify identity assertions
  using only public, non-secret material; possession of everything shipped to
  the customer MUST be insufficient to forge an assertion.
- **FR-004**: Identity assertions MUST be single-use and short-lived
  (validity measured in minutes), and MUST carry enough identity context
  (email, organization, team partition) for the instance to provision the
  user without contacting the central platform.
- **FR-005**: A user with an active central-platform session MUST be able to
  sign in to a permitted instance without re-entering credentials.
- **FR-006**: After sign-in, the instance MUST manage sessions locally;
  normal application use MUST NOT require central-platform availability.
- **FR-007**: Each instance MUST enforce its configured sign-in allowlist
  (permitted email domains and/or permitted organizations) at sign-in and at
  user provisioning; an empty allowlist means no restriction.
- **FR-008**: Our hosted Synmetrix instances MUST continue to operate exactly
  as they do today — sign-in flow, provisioning, and availability are
  unaffected by this feature, and they are subject to no standing checks.
  On-prem behavior activates only through explicit instance configuration.

**Instance registration and standing**

- **FR-009**: The central platform MUST maintain a registry of on-prem
  instances — customer account, allowed return location, permitted
  domains/organizations, standing (active/suspended), last check-in time, and
  reported version. In v1, platform operators manage registry entries
  directly through the platform's existing data tooling (no admin UI or
  management API is part of this feature); the only new operator-facing
  surfaces are the status and sign-in handoff endpoints the instances call.
- **FR-010**: Each instance MUST hold a unique instance credential, scoped to
  the customer's own account and revocable/reissuable centrally without
  customer reinstallation. In v1 the credential uses the central platform's
  existing account-scoped key store as-is; confinement to status-check-only
  capability arrives with the platform's planned key/authorization upgrade
  (WorkOS API keys with FGA claims) and MUST require no change on deployed
  instances when it lands.
- **FR-011**: Instances MUST periodically confirm their standing with the
  central platform (default every 6 hours) and cache the result with a
  bounded validity (default 72 hours).
- **FR-012**: While the cached standing is valid, central-platform
  unavailability MUST NOT affect instance operation; once it lapses without
  renewal, the instance MUST refuse new sign-ins and session renewals with an
  administrator-facing message, and MUST resume automatically when a check
  succeeds.
- **FR-013**: When an account is suspended centrally, the instance MUST
  refuse new sign-ins from its next status check onward, and active sessions
  MUST end no later than their next renewal.
- **FR-014**: Status check-ins MUST record last-seen time and instance
  software version centrally, visible to platform operators.

**Packaging**

- **FR-015**: The install bundle (single-host and Kubernetes variants) MUST
  be self-contained — every required supporting service included except
  customer-connected analytics databases — and MUST pull our built components
  from our distribution registry using customer-specific pull credentials.
- **FR-016**: The bundle's configuration templates MUST contain no central
  secrets; every secret is either generated by the customer or is the
  instance credential of FR-010. An automated audit of the deliverable MUST
  be able to confirm this.
- **FR-017**: Co-deployed solution components without their own login MUST be
  able to validate the instance's locally issued sessions/tokens using
  instance-local configuration, with the integration contract documented.

**Gateway portability**

- **FR-018**: The central platform's location MUST be instance configuration:
  an on-prem instance MUST be repointable to a new central gateway address
  (and the central platform relocatable, e.g. from app.fraios.dev to
  app.fraios.com or app.fraios.ai) through configuration changes alone — no
  reinstall, no rebuild, and no loss of existing local sessions. The shipped
  software MUST NOT hardcode any central platform domain.

### Key Entities

- **On-Prem Instance**: A registered customer deployment — customer account,
  public location (domain), assertion audience, allowlist, standing,
  credential reference, last check-in, version.
- **Identity Assertion**: Short-lived, single-use, instance-bound statement
  from the central platform that a specific user authenticated, carrying the
  identity context needed for local provisioning.
- **Standing Confirmation**: The cached result of a status check — standing
  plus a validity horizon that defines the offline grace window.
- **Instance Credential**: The revocable identifier an instance uses for
  status checks; scoped to that single purpose and that single instance.
- **Sign-in Allowlist**: Per-instance set of permitted email domains and/or
  organizations, enforced at sign-in and provisioning.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A security review of everything delivered to the customer finds
  zero credentials usable against other customers or against central systems
  beyond the customer's own account context — and nothing capable of forging
  identity assertions.
- **SC-002**: A user already signed in to the central platform completes
  on-prem sign-in in under 10 seconds; a user authenticating fresh completes
  it in under 2 minutes.
- **SC-003**: During a 72-hour simulated central outage, signed-in users
  experience zero interruption, and sign-ins keep working until the grace
  window lapses.
- **SC-004**: Suspending a customer account stops new sign-ins on their
  instance within one status-check interval (≤ 6 hours by default) in 100% of
  tests.
- **SC-005**: A customer administrator following only the install document
  reaches a working first sign-in within 1 hour on a prepared host.
- **SC-006**: Onboarding a second on-prem customer requires only registry
  entries and credential issuance — no changes to central authentication
  configuration or code.
- **SC-007**: Normal application use by a signed-in on-prem user generates
  zero requests to the central platform between sign-in and session expiry.
- **SC-008**: Relocating the central gateway to a different domain requires
  only a configuration change on each instance and zero changes to our hosted
  Synmetrix; all regression tests for the hosted sign-in flow pass unchanged
  throughout this feature.

## Assumptions

- Abler's users already exist (or will be created) in our central user pool;
  the instance's allowlist will pin Abler's email domain and organization.
- "Suspend" in v1 is a manual operator action in the central registry;
  automatic linkage to billing state can come later without changing the
  contract.
- Default tuning — assertion validity ≈ 2 minutes, status check every 6
  hours, grace window 72 hours — is configurable per instance centrally.
- When the grace window lapses, new sign-ins and session renewals stop;
  already-issued short-lived local tokens ride out their remaining validity
  (minutes). Data is never deleted by standing changes.
- No concrete second solution component ships in this feature; FR-017 is
  satisfied by the documented contract plus a stub-service test.
- The groundwork already drafted on this branch (self-contained install
  bundles, distribution-registry publishing, sign-in allowlist enforcement)
  is part of this feature and will be finished under it.
- Customer instances have outbound internet access to our central platform;
  fully air-gapped operation is out of scope.
- The central gateway currently answers at app.fraios.dev; that address is an
  operational detail, expected to change, and appears nowhere as a fixed
  value in shipped software or documentation templates (always as the
  "configure your gateway address" example).
- Central-platform work in this feature is additive only — new endpoints and
  one registry table — built against the existing account-scoped key store
  without restructuring it. The platform's planned move to WorkOS API keys
  with FGA claims supersedes the credential's storage/verification internals
  later; instances are insulated from that change because they only ever
  present the credential to central endpoints, never interpret it.
- Other development is in flight on the central platform; this feature's
  central-side changes are coordinated with that work and scheduled
  separately from the instance-side and packaging work.

## Out of Scope

- Air-gapped (no outbound connectivity) deployments.
- Customer-managed identity providers federating into our central pool.
- Automatic billing-system integration for standing changes.
- Usage metering/reporting beyond last-seen and version.
- Migration of existing hosted Abler data into the on-prem instance.
