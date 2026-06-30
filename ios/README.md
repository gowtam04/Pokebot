# Oak for iPhone

A native **Swift 6 / SwiftUI** client for Oak, the Pokémon reasoning chat agent. The
app is a pure client to Oak's existing Next.js backend (under `../web/`): it holds **no
LLM keys and no database** and talks only to the HTTP/SSE API. Architecture, decisions,
and the per-phase plan live in
[`../docs/features/iphone-app/`](../docs/features/iphone-app/).

- **Min iOS:** 18.0 · iPhone only (v1) · Swift 6 strict concurrency.
- **No third-party Swift packages** — Apple frameworks only (ADR-5). `xcodegen` is a
  build tool, not an app dependency.

## Layout

```
ios/
├── project.yml          XcodeGen spec — the source of truth for the Xcode project
├── OakApp/              app target (App, Networking, Models/Wire, Services, Features, UI, Support, Resources)
├── OakAppTests/         unit tests (Swift Testing) + committed wire/SSE fixtures
├── OakAppUITests/       XCUITest end-to-end suite (this is Phase 13)
└── ci/                  GitHub Actions workflow
```

The `*.xcodeproj` is **generated** from `project.yml` and **git-ignored** — never commit
it; regenerate locally and in CI.

## Generate & open the project

XcodeGen reads `project.yml` and emits `OakApp.xcodeproj` (sources are pulled by
directory glob, so files added by any phase are picked up automatically on
regeneration).

```bash
brew install xcodegen          # one-time
cd ios
xcodegen generate             # writes OakApp.xcodeproj
open OakApp.xcodeproj          # or: xed .
```

## Build & test (simulator: iPhone 17)

Pick a simulator that exists on your machine (`xcrun simctl list devices available`);
the examples use **iPhone 17**. Swift has no separate type-check step — a `build` *is*
the type-check.

```bash
cd ios

# Build (== type-check) the app for the simulator
xcodebuild build -scheme OakApp \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# Unit tests only (Swift Testing — fast, no backend, no Docker)
xcodebuild test -scheme OakApp -only-testing:OakAppTests \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# A single unit suite / test
xcodebuild test -scheme OakApp \
  -only-testing:OakAppTests/SSEParserTests \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

### UI tests (XCUITest, Phase 13)

The UI target only needs to **compile** for the default CI gate. Most of the E2E flows
are gated to a live backend (see below) and skip cleanly when it isn't configured; the
launch / navigation / no-crash checks run hermetically.

```bash
cd ios

# Compile-only gate (what the build verifier runs): the UI target must build for testing
xcodebuild build-for-testing -scheme OakApp \
  -destination 'platform=iOS Simulator,name=iPhone 17'

# Run the hermetic UI checks (gated live flows skip without OAK_E2E)
xcodebuild test -scheme OakApp -only-testing:OakAppUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

UI test suites (`OakAppUITests/`):

| Suite | Runs | Verifies |
|---|---|---|
| `LaunchUITests` | hermetic | boots to the 4-tab shell; all parity tabs reachable |
| `ResilienceUITests` | hermetic | tab navigation / background-foreground / transport-error path never crash (M-NFR-4) |
| `ChatCriticalPathUITests` | live (CP5) | launch → ask → streaming feedback → finalized answer (M-SUCCESS-1/2/3, M-NFR-2) |
| `CrossFeatureUITests` | live (CP5) | guest→sign-in→history; active-team→chat→artifact sheet |

Performance/smoothness (M-NFR-2/3/5) is assessed in the **CP5** manual device pass with
Instruments (cold launch, thread scroll, artifact-sheet open, streaming) rather than an
automated metric here — `measure(metrics:)` is an escaping ObjC block that does not
compose cleanly with the app's `@MainActor`-isolated launch under Swift 6 strict
concurrency.

Shared targets/helpers and the launch-argument contract live in
`OakAppUITests/OakUITestSupport.swift`.

## Live E2E configuration (deferred — CP5)

The critical-path and cross-feature flows need a reachable backend and, for sign-in, a
real one-time code. They are gated by environment variables and **skip** unless set:

| Variable | Purpose |
|---|---|
| `OAK_E2E=1` | opt the run into the live, staging-backed flows |
| `OAK_TEST_EMAIL` | email to sign in with during the cross-feature flow |
| `OAK_TEST_OTP` | a known-good OTP for that account (otherwise the OTP step is manual) |

```bash
OAK_E2E=1 OAK_TEST_EMAIL=you@example.com OAK_TEST_OTP=123456 \
  xcodebuild test -scheme OakApp -only-testing:OakAppUITests \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

**Launch-argument / mock seam.** `launchOak(_:)` passes `-OakUITest` plus a
`-OakUITestScenario` value (`live`, `mockAnswer`, `mockTransportError`, `mockSignedIn`).
A future **DEBUG-only** test seam in the app can honor these to inject `Fake…` services
and run the mock scenarios fully offline. Until that seam is wired (an additive,
app-owned change), the app ignores the unknown arguments and boots normally — the
hermetic tests still pass and the live tests still skip. Adding the seam, and wiring the
real feature views into `RootView`, are the prerequisites for running the gated flows
hermetically/on staging.

## BaseURL: staging vs production

The backend base URL is selected by build configuration in
`OakApp/Networking/BaseURL.swift`:

- **Debug** scheme → **staging** (the `OAK_STAGING` compilation condition, set only in
  the Debug config by `project.yml`).
- **Release** scheme → **production**.

There is no dedicated staging Fly app yet, so `staging` currently points at the
production host (`oak-gowtam.fly.dev`). Point `BaseURL.staging` at a real staging app
before submission if one is created (see `BaseURL.swift` TODO and
`docs/features/iphone-app/architecture/deployment.md`).

## Deferred human checkpoints

These are **out of scope for the automated build gate** and require a human, a device,
and/or live infrastructure. See the Integration Checkpoints in
[`implementation-plan.md`](../docs/features/iphone-app/architecture/implementation-plan.md).

- **CP1 — networking ⇄ backend smoke** (after P4): decode `/api/health`, `/api/entity`,
  and a real SSE chat stream end-to-end; confirm `Authorization: Bearer` authenticates.
- **CP2 — auth end-to-end** (after P5): request code → verify returns a token → a Bearer
  call to `/api/conversations` succeeds → sign-out clears the token. Needs a real OTP.
- **CP4 — signed-in data round-trip** (after P9+P10): create a team, set it active, ask a
  team question, confirm the conversation is saved and resumable on a fresh launch and on
  the web app.
- **CP5 — release E2E** (after P13): run the full XCUITest suite **on a device against
  staging** (`OAK_E2E=1`), plus the manual parity / accessibility (VoiceOver, largest
  Dynamic Type) / offline (airplane-mode) pass, and an Instruments scroll/sheet/streaming
  smoothness check (M-NFR-3).
- **Signing & distribution:** Apple Developer Program account, automatic signing /
  provisioning, archive, and **TestFlight** internal ring before App Store submission
  (deployment.md). The automated gate builds for the simulator and does **not** sign.
- **IP / trademark review:** Pokémon-related naming/branding review before submission —
  the one genuine non-engineering blocker (`decisions.md`).

> The Phase-13 gate verifies only that the UI test target **builds for testing**. The
> live E2E run (CP5) is a human follow-up.
