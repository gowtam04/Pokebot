# API Design

The client consumes the **existing** Oak HTTP/SSE API (no redesign). This file is the
contract the iOS networking layer builds against, plus the **two additive backend
changes**. Shapes below come from the codebase audit; treat the TS source as
authoritative.

Base URL: the production Fly.io origin (config per build scheme — see `deployment.md`).
All requests are HTTPS. Auth is carried as **`Authorization: Bearer <token>`** (new;
see Change 2) for signed-in calls; absence of the header = guest.

> **⚠️ Updated — the "active team" seam was removed (web change, 2026-06).** The
> header active-team selector is gone; saved teams are now referenced **by name in
> chat** (the agent calls `list_teams` then `get_team`, and asks for clarification
> on 0 / >1 match). Consequently: the chat request no longer carries
> `active_team_id`; `PATCH /api/conversations/{id}` no longer accepts
> `active_team_id`; `GET /api/conversations/{id}` (`ConversationDetail`) no longer
> returns it; `DELETE /api/teams/{id}` no longer nulls any reference; and the
> `conversation.active_team_id` column was dropped. The tables below still show the
> old fields — they are struck through inline and the iOS client must NOT send or
> read `active_team_id`. The web tool contract is `docs/agent-design/tools.md`
> (T12 `get_team`, T16 `list_teams`).

## Endpoints consumed (existing — unchanged)

### Auth
| Method | Path | Body | Returns | Auth |
|---|---|---|---|---|
| POST | `/api/auth/request-code` | `{ email }` | `{ ok:true }` or `{ code, message }` (always 200 except 429/502) | none |
| POST | `/api/auth/verify` | `{ email, code }` | `{ ok, email, created, token }` **(+token: see Change 2)**; also sets `oak_session` cookie | none |
| GET | `/api/auth/me` | — | `{ signedIn:true, email }` or `{ signedIn:false }` (200) | optional |
| POST | `/api/auth/signout` | — | `{ ok:true }` (idempotent) | optional |

Auth error codes: `invalid_email`, `rate_limited` (429, `Retry-After`), `email_failed`
(502); verify: `invalid_code` (`attemptsRemaining`), `invalid_or_expired`,
`too_many_attempts`. OTP: 6-digit, 10-min expiry, 5 wrong attempts/code, resend
cooldown 60s, 5/email/hr, 20/IP/hr; verify 20/IP/10min.

### Chat (SSE)
`POST /api/chat` — request body and SSE events per `data-model.md`.
- Pre-stream errors (JSON, before the stream): `invalid_request` (400),
  `invalid_image` (400), `payload_too_large` (413, >16 MiB Content-Length),
  `input_too_long` (413, >2000 chars), `rate_limited` (429, `Retry-After`),
  `model_unavailable` (503).
- Rate limits: signed-in 60/60s (keyed on account), guest 20/60s (keyed on IP).
- Image caps: ≤4 images; ≤3.75 MiB/image and ≤10 MiB total (decoded); JPEG/PNG/GIF/WebP
  (magic-byte sniffed). Send raw base64 (no `data:` prefix).
- Stream order: `tool_activity`* → `answer_start`*/`answer_delta`* → exactly one
  terminal `answer` (or `error` on transport fault). Heartbeat `: keep-alive` every 15s.

### Conversations (signed-in; guests get `{conversations:[]}` or 401 per route)
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/conversations` | `?q=&format=` | `{ conversations: ConversationSummary[] }` (guest → `[]`, 200) |
| GET | `/api/conversations/{id}` | — | `ConversationDetail` (401 guest / 404 not-owned) |
| PATCH | `/api/conversations/{id}` | `{ title?, pinned? }` (≥1) ~~`active_team_id?`~~ removed | `{ ok:true }` |
| DELETE | `/api/conversations/{id}` | — | `{ ok:true }` |
| POST | `/api/conversations/import` | `{ session_id, champions_mode?, turns[] }` | `{ id: string\|null }` |

Notes: ~~`active_team_id` is validated server-side~~ — **removed**; `active_team_id` is
no longer a recognized PATCH field (a body with only `active_team_id` now 400s).
`import` is the guest→account save; idempotent on turn ids.

### Teams (signed-in; 401 for guests)
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/api/teams` | `?format=` | `{ teams: Team[] }` |
| POST | `/api/teams` | `{ format, name?, members? }` | `{ team, validation }` |
| GET | `/api/teams/{id}` | — | `{ team, validation }` |
| PUT | `/api/teams/{id}` | `{ name?, members? }` (≥1) | `{ team, validation }` |
| DELETE | `/api/teams/{id}` | — | `{ ok:true }` ~~(nulls referencing `active_team_id`)~~ — no refs to null |
| POST | `/api/teams/import` | `{ format, paste }` | `{ team, validation, notes }` |
| GET | `/api/teams/{id}/export` | — | `{ paste }` (Showdown text) |
| POST | `/api/teams/{id}/duplicate` | — | `{ team, validation }` |

`validation` is `TeamValidationResult` (warn-but-allow). `import` never fails wholesale;
unresolved parts come back as `notes` (`ImportNote[]`).

### Artifacts / reference (public, no auth)
| Method | Path | Query | Returns |
|---|---|---|---|
| GET | `/api/entity` | `kind=pokemon\|move\|ability\|item\|type & q & format` | `{ status:"ok", kind, … }` \| `{ status:"not_found", suggestions }` \| `{ status:"unavailable" }` (all 200); bad params 400 |
| GET | `/api/sprites` | `format & names` (≤24, comma-sep slugs) | `{ refs: { slug: { display_name, sprite_url, types, base_stats } } }` |
| GET | `/api/health` | — | `{ status:"ok" }` |

`entity` is a discriminated union on `kind`; the Pokémon variant includes
`data.matchups` (weak/resist/immune, optional quad) and `data.movepool` — enough to
render the full entity artifact. Quote the exact shape from
`web/src/lib/entity-artifact.ts` when writing the Swift DTO.

## Backend changes (additive — must not alter web behavior)

### Change 1 — Account deletion (new endpoint)
`DELETE /api/auth/account`
- **Auth:** required (Bearer or cookie). Guest → 401.
- **Behavior:** in one transaction, cascade-delete all data for `account.id`
  (`message → conversation → team → auth_session → otp_code → account`; see
  `data-model.md` §C). Then the response also clears the `oak_session` cookie (parity
  with signout) so a cookie-based web session is invalidated too.
- **Response:** `{ ok:true }` (200). Idempotent-ish: a now-orphaned token → 401.
- **New code:** `web/src/app/api/auth/account/route.ts` (DELETE handler) +
  `deleteAccount(accountId)` in `web/src/data/repos/accounts-repo.ts`.
- **Satisfies:** M-NFR-6, M-ACCT-US-6, M-BR-ACCT-6.

### Change 2 — Bearer-token auth adaptation
- **`verify` returns the token.** `POST /api/auth/verify` adds `token: string` (the raw
  256-bit hex token it already generates) to its 200 body. The cookie is still set
  (web unaffected). The client stores `token` in the Keychain and ignores the cookie.
- **Resolver accepts Bearer.** The single session-resolution path
  (`web/src/server/auth/current-user.ts` → `sessions.ts`) is extended: if no valid
  `oak_session` cookie is present, read `Authorization: Bearer <token>`, hash it
  (same SHA-256), and resolve identically. **Cookie path is tried first / unchanged**,
  so web is byte-for-byte the same; Bearer is a pure fallback.
- **Scope:** because every authenticated route resolves identity through that one
  function, this one change lights up conversations, teams, chat (signed-in
  rate-limit/identity), and account deletion for the native client.
- **Satisfies:** M-BR-ACCT-5 (token in Keychain), M-ACCT-US-2, M-BR-PLAT-3.
- **ADR:** ADR-2. **Fallback:** if the team prefers zero backend change, the cookie-jar
  path still works (ADR-2 records the rejected alternative).

## Authentication & Authorization (client side)

- **Guest:** no `Authorization` header. Chat works; conversations list returns `[]`;
  team endpoints return 401 (the app gates these behind a sign-in prompt, not an error).
- **Signed-in:** `Authorization: Bearer <token>` on every request. A `401` on a
  previously-signed-in call means the session expired/was revoked → the client drops the
  token, returns to guest, and surfaces a re-sign-in prompt.
- **Token lifetime:** 30-day fixed window (no sliding refresh). On expiry the user
  re-requests a code. (If sliding sessions are wanted later, that's a backend change —
  out of scope; noted in `decisions.md` Unresolved.)

## Error Handling (client mapping)

The networking layer maps responses to `OakError` (see `conventions.md`):
- Transport failure / no connection → `.transport` (→ "no connection" UI, retry).
- `429` + `Retry-After` → `.rateLimited(retryAfter:)` (→ specific message;
  "sign in raises the limit" for guests).
- `401` on an authed call → `.unauthorized` (→ drop token, return to guest).
- `4xx/5xx` with `{code,message}` → `.http(status:code:message:)`.
- Decode mismatch → `.decoding` (logged; should be impossible if DTOs match — caught by
  Phase 2 contract tests).
- **In-domain failures are NOT errors:** an `OakAnswer` with
  `status != answered`, an `entity` `not_found/unavailable`, or team `validation`
  warnings are normal successful results rendered in the UI (mirrors the backend's
  "never throw in-domain" stance).

## Pagination / Filtering / Sorting

- Conversations & teams: no pagination in the API (full list returned); filtering is
  server-side via `?q=` / `?format=`. The client may additionally filter/sort in-memory
  for responsiveness. If list sizes grow enough to need pagination, that's a future
  backend change (noted in `decisions.md` Unresolved).
