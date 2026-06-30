# Oak for iPhone — Business Requirements: Overview

> **⚠️ Updated — the "active team" feature was removed (web change, 2026-06).** The
> web app dropped the server-bound active-team seam; saved teams are now referenced
> **by name in chat** (the agent calls `list_teams` then `get_team`). The iOS client
> matches: there is no active-team chip/selector, no `setActiveTeam`, and no
> `active_team_id` on any request. Inline mentions of "active team" below are
> superseded by this note.

> A native **iPhone** client for Oak, the existing deployed Pokémon chat agent
> (`README.md`, `CLAUDE.md`). This document set defines **what** the iPhone app
> must do and **why**, for handoff to a solution architect. It does not make
> technical decisions; technology preferences are recorded as constraints.
>
> **ID scoping.** Every user story, acceptance criterion, and business rule in
> this doc set is **prefixed `M-`** (mobile) to keep it distinct from the
> identically-named IDs in the web feature docs (`docs/features/*/requirements/`).
> IDs are stable and addressable downstream — append, never renumber.

## What we're building

A **native iOS (iPhone) application** that brings Oak to the App Store at **full
feature parity** with the existing web app. Oak answers natural-language Pokémon
questions by reasoning on top of data — every answer carries reasoning, cited
sources, explicit inference/uncertainty flags, and the generation/format it's
based on. The iPhone app must deliver that same product, natively, with an
experience that feels like a first-class iPhone app rather than a website in a
shell.

The app is a **client** to Oak's existing deployed backend (the same product,
the same accounts, the same data); it is **not** a new product or a separate
backend. Where mobile genuinely needs something the current web API doesn't
expose, new endpoints may be added to the existing backend (see
`platform-and-operational.md`).

## Why this exists

The motivations the product owner identified, in priority order:

1. **Better mobile UX** — a polished, fast, touch-native experience that beats a
   responsive web page (the primary driver).
2. **App Store presence** — discoverability and credibility as a real,
   downloadable app.
3. **Native device capabilities** — starting with camera/photo capture for image
   questions; with push notifications as a known future goal (deferred from v1).

If we don't build it, Oak remains web-only — usable on a phone browser, but
without App Store discovery, without native capture, and without the responsive,
gesture-driven feel mobile users expect.

## Scope

**In scope (v1): full feature parity with the web app, delivered natively.**
The functional areas, each detailed in its own file:

- **Chat experience** (`chat-experience.md`) — the core reasoned-answer chat,
  token-by-token streaming with live tool activity, multi-turn context, the
  Champions-mode toggle, and **image input via the iPhone camera / photo
  library**.
- **Accounts & access** (`accounts-and-access.md`) — guest mode and email
  one-time-code (OTP) sign-in, sessions, tiered rate limits, guest→sign-in
  continuity, and **in-app account deletion** (App Store requirement).
- **History & teams** (`history-and-teams.md`) — durable chat history (browse,
  search, filter by format, pin, rename, delete, resume) and the full team
  builder (create/edit, Showdown paste/export, agent-assisted drafting, set
  active team, warn-but-allow validation).
- **Artifact viewer** (`artifact-viewer.md`) — rich entity/answer artifacts
  presented as a **bottom sheet** over the chat, with entity drill-down and a
  back stack.
- **UI & experience** (`ui-and-experience.md`) — design direction (native iOS
  structure carrying Oak's brand), information architecture/navigation, key
  screens, interaction patterns, accessibility.
- **Platform & operational** (`platform-and-operational.md`) — backend
  relationship, online-only/offline behavior, performance/reliability, App Store
  compliance, security, constraints, out-of-scope, and open questions.

## Users and personas

Inherited from the web product (`docs/features/account-creation/requirements/`),
unchanged in kind for mobile:

- **Guest (anonymous visitor).** Has not signed in. Can use chat fully on the
  iPhone, subject to the lower guest rate limit, with an ephemeral, on-device
  session and no persisted identity. Offered an unobtrusive way to sign in.
- **Registered user.** Has an account identified by a verified email address.
  Signed in via a long-lived session; gets the higher rate limit; this is the
  identity that durable history and saved teams attach to. The **same account**
  works across web and iPhone — a conversation or team created on one shows up on
  the other. All registered users are peers; there is **no admin role**.

The user is a competitively-literate Pokémon fan who is also a casual Pokédex
user — using Oak for both serious team-building/battle-math and quick curiosity
lookups, now on the go.

## Success criteria

The owner's stated definition of success is **parity & quality**:

- **M-SUCCESS-1** — An iPhone user can do **everything** a web user can: ask
  reasoned/cited questions, use guest or signed-in mode, browse/resume durable
  history, build and manage teams, open artifacts, attach images, and toggle
  Champions mode. No core web capability is missing in v1 (except the explicitly
  deferred items in `platform-and-operational.md` §Out of Scope).
- **M-SUCCESS-2** — The experience feels **genuinely native and polished** — not
  a web view in a wrapper. Native navigation/gestures, smooth token-by-token
  streaming, native camera/photo capture, and Oak's brand carried through.
- **M-SUCCESS-3** — Answers render with **full structural fidelity** to the
  web — reasoning, citations, inference/uncertainty flags, format tag, sprites,
  and tables all present and correct.

Adoption signals (downloads/active users, App Store rating ≥4.5, retention) are
**aspirational, not primary** for v1 — the owner prioritized parity and quality
over a numeric growth target. They are recorded here so the architect knows the
app must be instrumented enough to observe them later, not optimized for them now.

## Priority guidance for the architect

This is build-order guidance only; it does **not** restructure the requirements
(each functional-area file stands on its own).

1. **Foundation** — networking to the existing backend (SSE streaming client),
   guest session, and the core chat loop with streamed/cited answers. This is the
   product's point; everything else hangs off it.
2. **Accounts & access** — email OTP sign-in, sessions, rate-limit handling,
   guest→sign-in continuity, account deletion.
3. **History & teams** — durable history browse/resume, then the team builder.
4. **Artifact viewer** — bottom-sheet artifacts and entity drill-down.
5. **Camera/photo input** — native capture/picker feeding the existing image
   pipeline.
6. **Polish & App Store readiness** — design fidelity, accessibility, privacy
   labels, store metadata.

## Relationship to existing docs

- The web feature requirements (`docs/features/{account-creation,chat-history,
  team-builder,artifact-viewer}/requirements/`) define the **canonical product
  behavior** these mobile docs reuse. Where this doc set says "same as web," it
  means those specs — re-expressed for a native iPhone surface, not redesigned.
- `CLAUDE.md` already anticipates a mobile client talking to the **`POST
  /api/chat` (SSE)** seam, with no LLM keys or DB access on the client. This app
  realizes that intent natively.
