# Account Creation (Email + OTP Auth) — Business Requirements

> Refines backlog item **B-1 — Account creation** (`docs/backlog.md`) into a
> buildable spec. This feature changes Oak from a single-user, no-auth tool
> into a **multi-tenant** app with **passwordless email-OTP** accounts, while
> keeping an **anonymous guest mode**. It supersedes the "Single user — no
> authentication, accounts, or multi-user access control" stance in
> `docs/requirements/requirements.md` (§Non-Functional, §Out of Scope), which
> should be read as superseded for the auth dimension once this ships.
>
> IDs are stable and addressable downstream. Append; never renumber.

## Overview

Today Oak is single-user and stateless: there are no accounts, identity is a
server-controlled single session, and conversation history lives only in memory.
This feature introduces **accounts** so the product can become genuinely
multi-user and, later, persist per-person data (teams — B-2, chat history — B-3).

Authentication is **passwordless via a one-time code emailed to the user**. A
single unified flow handles both first-time signup and returning login: the user
enters their email, receives a 6-digit code, and verifies it. If the email is
new, an account is created automatically; if it already exists, the user is
logged in. There are no passwords, no social logins, and no magic links.

Crucially, **the chat remains usable without an account** (guest mode). Signing
in is an upgrade — it raises usage limits, preserves the conversation in
progress, and provides the identity that future persistence features will attach
to — not a wall in front of the product.

### Goals

- Let anyone create an account and sign in using only their email address plus a
  one-time code — no password to choose, store, or reset.
- Keep Oak instantly usable for anonymous guests; make signing in a low-
  friction upgrade rather than a gate.
- Establish a per-account identity that later features (saved teams, persisted
  chat history) can be scoped to, with strict isolation between accounts.
- Differentiate usage limits between guests and signed-in users.

### Success Criteria

- A brand-new visitor can go from "enter email" to "signed in with an account"
  in one flow, with no password step, and the account exists afterward.
- A returning user entering the same email is logged into the **same** account
  (no duplicate account is created).
- An anonymous visitor can ask Oak questions and get answers without ever
  signing in.
- A guest who signs in mid-conversation keeps the conversation that is on screen.
- Signed-in users get a higher request allowance than guests, and one account
  cannot bypass its limit by spawning guest sessions.

## Users and Personas

This feature expands the persona set from the single "Owner" to:

- **Guest (anonymous visitor).** Has not signed in. Can use the chat fully, but
  is subject to the (lower) guest rate limit and has no persisted identity.
  Presented with an unobtrusive way to sign in.
- **Registered user.** Has an account identified by a verified email address. Is
  signed in via a long-lived session, gets the higher rate limit, and is the
  identity that future per-account data (teams, history) will belong to. All
  registered users are peers — there is no admin or elevated role.

There is **no admin/owner role** in this build: registration is open, so there
is no allowlist to manage and no cross-account visibility for anyone.

## User Stories

> Namespaced `AUTH-` for this feature. IDs are stable; append, never renumber.

### Guest access

- **AUTH-US-1** — As a visitor, I want to use Oak without creating an
  account, so that I can get answers immediately.
  - **AC-1.1** — Given I have never signed in, when I open the app and submit a
    question, then I receive a normal answer without being required to
    authenticate.
  - **AC-1.2** — Given I am a guest, when I use the app, then a clear, non-modal
    affordance to sign in is visible, but it does not block the chat.
  - **AC-1.3** — Given I am a guest, then my requests are counted against the
    **guest** rate limit (BR-A8), not an account.

### Signing up / in (unified flow)

- **AUTH-US-2** — As a visitor, I want to sign up or sign in using only my email
  and a one-time code, so that I never have to create or remember a password.
  - **AC-2.1** — Given I enter a syntactically valid email and request a code,
    when the request is accepted, then the system emails a one-time code to that
    address and shows a code-entry step.
  - **AC-2.2** — Given the system has accepted my email, then the response is the
    same whether or not that email already has an account — it never reveals
    whether the email is registered (BR-A1).
  - **AC-2.3** — Given I enter the correct, unexpired code, when the email has
    **no** existing account, then a new account is created for that email and I
    am signed into it.
  - **AC-2.4** — Given I enter the correct, unexpired code, when the email
    **already** has an account, then I am signed into that same existing account
    and no duplicate account is created.
  - **AC-2.5** — Given I enter an incorrect code, then I am told the code is
    invalid and allowed to retry, until the attempt limit is reached (BR-A4).
  - **AC-2.6** — Given the code has expired (BR-A3) or has already been used,
    when I submit it, then I am told it is no longer valid and prompted to
    request a new one.
  - **AC-2.7** — Given I mistyped my email, when I realize it, then I can go back
    and re-enter a different email and request a new code.

- **AUTH-US-3** — As a user, I want to request a fresh code if the first one
  doesn't arrive, so that a lost email doesn't strand me.
  - **AC-3.1** — Given I am on the code-entry step, when a short cooldown has
    elapsed, then I can request a new code; before the cooldown elapses the
    resend action is unavailable and the remaining wait is indicated (BR-A5).
  - **AC-3.2** — Given a new code is issued, then any previously issued,
    unexpired code for that email is invalidated (only the latest code works).
  - **AC-3.3** — Given I have requested codes too many times in a short window,
    then further requests are refused with a clear message until the window
    resets (BR-A5, BR-A6).

### Staying signed in / out

- **AUTH-US-4** — As a user, I want to stay signed in across visits and browser
  restarts, so that I don't have to re-verify constantly.
  - **AC-4.1** — Given I verified a code, when I close and reopen the browser
    within the session lifetime (BR-A7), then I am still signed in without
    re-verifying.
  - **AC-4.2** — Given my session has expired or been ended, when I return, then
    I am treated as a guest and must verify a new code to sign in again.
  - **AC-4.3** — Given I sign in on a second device, then both devices have
    independent active sessions for the same account (BR-A7).

- **AUTH-US-5** — As a user, I want to sign out, so that I can end my session on
  the current device.
  - **AC-5.1** — Given I am signed in, when I choose sign out, then my session on
    the current device is ended and I am returned to the guest experience.
  - **AC-5.2** — Sign out affects only the current device's session; sessions on
    other devices remain active (BR-A7).

### Continuity and limits

- **AUTH-US-6** — As a guest who signs in mid-conversation, I want the
  conversation already on screen to be preserved, so that I don't lose my place
  by signing in.
  - **AC-6.1** — Given I have an active conversation as a guest, when I complete
    sign-in, then the conversation visible before sign-in remains visible and
    usable afterward (BR-A10).
  - **AC-6.2** — Follow-up questions after signing in continue against that same
    on-screen conversation context.

- **AUTH-US-7** — As a signed-in user, I want a more generous usage allowance
  than guests, so that signing in is worthwhile.
  - **AC-7.1** — Given I am signed in, then my requests are counted per-account
    against the higher signed-in limit (BR-A8).
  - **AC-7.2** — Given I sign out and continue as a guest, then I revert to the
    guest limit.
  - **AC-7.3** — Creating guest sessions does not let a single user exceed what
    their account would allow beyond the guest tier (guests are independently
    limited per IP/session — BR-A8).

## Functional Requirements

### Authentication flow

- A single entry point collects an **email address** and requests a one-time
  code; a second step collects the **code** and completes authentication.
- The same flow serves signup and login; account creation vs. login is decided
  **after** successful code verification based on whether the email already
  exists (BR-A1).
- Accounts are identified **solely by email**. No display name, password, or
  other profile field is collected at signup (a display name may be derived from
  the email for display purposes).
- On successful verification, a long-lived session is established for the device
  (BR-A7).

### One-time codes

- Codes are delivered by **transactional email** to the address entered.
- Code format, lifetime, single-use, attempt lockout, resend cooldown, and
  request caps are governed by BR-A3 through BR-A6.

### Sessions

- Sessions are long-lived, survive browser restarts, are independent per device,
  and end on explicit sign out or expiry (BR-A7).

### Guest mode

- The chat is fully functional for unauthenticated guests (AUTH-US-1).
- Guest activity is rate-limited independently of accounts (BR-A8).
- The conversation on screen is preserved across the guest→signed-in transition
  (BR-A10).

### Rate limiting

- The current per-session limit is replaced by a tiered model: per-account for
  signed-in users (higher), per-IP/session for guests (lower) — BR-A8.

### Account management

- **Sign out** is the only account-management action in scope (AUTH-US-5).
  Changing email and deleting an account are explicitly **out of scope** for
  this build (see Out of Scope).

### Data isolation (forward-looking)

- This build does not itself persist per-user content, but the account model it
  establishes must enforce strict per-account isolation for the data that later
  features attach to it (teams — B-2, chat history — B-3): no account may read
  or write another account's data (BR-A9).

## Business Rules

> IDs stable and referenceable by architecture and tests.

- **BR-A1 — Unified, non-enumerating flow.** Requesting a code always behaves
  identically whether or not the email is registered (no "account exists" /
  "no such user" signal). Account creation vs. login is resolved only after a
  code is successfully verified: unknown email → create account and sign in;
  known email → sign into the existing account. Exactly one account exists per
  email.
- **BR-A2 — Email is the identity and is verified by OTP.** An account is keyed
  by a unique, normalized email address. Successfully verifying a code proves
  control of that address, so no separate email-verification step exists.
- **BR-A3 — Code format and lifetime.** Codes are 6-digit numeric, single-use,
  and expire ~10 minutes after issuance. An expired or already-used code cannot
  authenticate.
- **BR-A4 — Verification attempt lockout.** After ~5 incorrect attempts against
  a given code, that code is invalidated and the user must request a new one.
- **BR-A5 — Resend cooldown and supersession.** A new code can be requested only
  after a short cooldown (~60s). Issuing a new code invalidates any prior
  unexpired code for that email (only the most recent code is valid).
- **BR-A6 — Request abuse limits.** The number of codes that can be requested for
  a given email, and from a given IP, within a window (e.g. per hour) is capped
  to deter email-bombing and enumeration. Exceeding the cap refuses further
  requests with a clear message until the window resets.
- **BR-A7 — Session longevity and scope.** A verified session lasts ~30 days,
  survives browser restarts, and persists until expiry or explicit sign out.
  Sessions are independent per device; signing out ends only the current
  device's session. (Targeting ~30 days is a default the architect may tune.)
- **BR-A8 — Tiered rate limits.** Signed-in users are rate-limited per account
  with a higher allowance; guests are rate-limited per IP/session with a lower
  allowance. The two pools are independent so guest sessions cannot be used to
  exceed account-tier usage beyond the guest tier.
- **BR-A9 — Strict per-account data isolation.** Any per-user persisted data
  (now or in future features) is scoped to its owning account; no cross-account
  read or write is permitted.
- **BR-A10 — Guest conversation continuity.** Completing sign-in does not reset
  or discard the conversation currently on screen; it is preserved into the
  signed-in session.
- **BR-A11 — Auth is orthogonal to agent capability.** Guests and signed-in
  users receive the same agent behavior, tools, and answer quality (including
  the existing Champions-mode toggle); only usage limits and persistence (later)
  differ by auth state.

## Non-Functional Requirements

- **Multi-tenancy.** The system moves from single-user to many concurrent,
  isolated accounts. Identity, sessions, and limits must be correct under
  concurrent multi-user access.
- **PII handling.** Email addresses are personal data and are now stored. They
  must be stored and transmitted responsibly; one-time codes must not be stored
  or logged in a way that allows reuse.
- **Email delivery dependency.** Authentication now depends on outbound
  transactional email. If sending a code fails, the user is told and can retry;
  a delivery delay must not corrupt the flow (the code remains valid until
  expiry).
- **Latency.** The code email should typically arrive within seconds to about a
  minute. Requesting a code and verifying it should feel as responsive as the
  rest of the app.
- **Reliability.** Auth is best-effort consistent with the rest of this personal-
  scale project, but must never create duplicate accounts for one email or leak
  one account's session/data to another.
- **Security posture.** Passwordless by design (no password storage/reset
  surface). Codes are short-lived, single-use, attempt-limited, and rate-limited
  (BR-A3–A6). The flow is non-enumerating (BR-A1).

## UI/UX Vision

- **Sign-in affordance.** For guests, a clear but non-blocking entry point
  (e.g. a "Sign in" control in the app chrome) that does not interrupt chatting
  (AC-1.2).
- **Two-step auth UI.** Step 1: a single email field with a "Send code" action.
  Step 2: a code-entry field with a "Verify" action, a "Resend code" control
  (disabled during cooldown with the remaining time shown), and a way to go back
  and correct the email.
- **States and feedback.** Clear, friendly messaging for: code sent, invalid
  code, expired/used code, too many attempts, resend cooldown, and request-limit
  reached. Messages must not reveal whether an email is registered (BR-A1).
- **Signed-in state.** The UI reflects that the user is signed in and offers
  **Sign out**. The conversation already on screen remains visible across
  sign-in (AUTH-US-6).
- **Consistency.** Auth screens should match Oak's existing visual language
  (see `docs/design-system/design-system.md`); this feature does not introduce a
  new look-and-feel.

## Constraints and Preferences

> Inputs for the solution architect — not decisions made here.

- **Existing stack (hard constraint).** Oak is a TypeScript / Next.js
  (App Router) monolith with a Drizzle + Postgres (node-postgres) data layer
  (see `CLAUDE.md`, `docs/architecture/design.md`). Identity, sessions, and
  one-time codes should live within this existing data layer rather than a
  separate system, unless the architect makes a deliberate, documented case
  otherwise.
- **Replaces the server-controlled single session.** `src/app/api/chat/route.ts`
  currently resolves a single server-controlled session and applies a per-session
  rate limit *before* opening the SSE stream; this must become auth-aware
  (guest vs. account) and apply tiered limits (BR-A8). The Champions-mode toggle
  and SSE contract are unaffected (BR-A11).
- **Transactional email provider needed.** The system must gain the ability to
  send transactional email; choice of provider/mechanism is the architect's.
- **Guest identification mechanism.** A means to identify/limit guests (e.g.
  cookie and/or IP) is required for BR-A8; the mechanism is the architect's.
- **Session mechanism.** The session technology (cookie-based DB sessions,
  signed tokens, etc.) and its ~30-day lifetime tuning are the architect's,
  subject to BR-A7.
- **Auth approach.** Whether to hand-roll the OTP/session logic or adopt an auth
  library is the architect's call, provided the rules above hold (passwordless
  email-OTP, non-enumerating, tiered limits, guest mode).
- **No pre-existing per-user data to migrate.** The app is currently stateless
  (in-memory session history, no persisted teams/chats), so there is no existing
  per-user data set to migrate into accounts; the first deploy starts clean.

## Open Questions

- **Account deletion / data export / compliance.** Deleting an account is out of
  scope here, but going genuinely public may eventually require account deletion
  and basic data-subject handling (e.g. GDPR). Is this needed before a public
  launch, and if so, when?
- **Change-email path.** Deferred (not in scope). Confirm it stays deferred and
  isn't needed for an early multi-user release.
- **Exact limit values.** Concrete numbers for: guest vs. signed-in request
  quotas (BR-A8), codes-per-hour caps (BR-A6), resend cooldown (BR-A5), and the
  session lifetime (BR-A7) — the "~" values above are defaults to confirm.
- **Email sender identity.** From-address, domain, and any branding for the OTP
  email.
- **Preserved-thread fate once history lands (B-3).** When chat history is built,
  should the preserved guest conversation be auto-saved to the new account, and
  what about the guest's history before they had an account?
- **Session revocation.** Is "sign out everywhere" / viewing & revoking other
  devices' sessions wanted later? (Not in this build.)

## Out of Scope

Hard boundaries for this build. A builder must not add these without them being
moved into scope above.

- **Passwords, social login / OAuth, SSO, and link-based magic links.** The only
  authentication mechanism is a numeric one-time code emailed to the user.
- **Changing an account's email address.**
- **Deleting an account or its data**, and data export.
- **Account settings/profile beyond Sign out** (no display-name editing,
  preferences, avatars, etc.).
- **Persisting teams (B-2) and chat history (B-3).** Accounts must be designed so
  these can attach later (BR-A9), but the persistence itself is not built here.
- **Admin role, user management, allowlists, or moderation** — registration is
  open and all accounts are peers.
- **Multi-device session management** — viewing or revoking other sessions, and
  "sign out everywhere."
- **Password reset** — not applicable (no passwords).
- **Roles/permissions beyond the guest vs. registered-user distinction.**
- **Migrating pre-existing per-user data** — none exists (the app is currently
  stateless).
