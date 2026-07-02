# Oak — Implementation Assessment

> Deep review of the **current implementation** under `web/src/` (not the docs).
> Every finding is traced against the code with `file:line` evidence.
> **CONFIRMED** = the failing path was traced; **PLAUSIBLE** = worth a look, not fully traced.
>
> Reviewed at commit on branch `develop`. Verified locally: `typecheck` clean, `lint` clean,
> jsdom component/full-stack suite green (638/638). The node/Testcontainers project was **not**
> run (no Docker daemon available at review time).
>
> Findings were produced by a primary pass plus three parallel deep-dives (security, testing/eval,
> API/SSE correctness). Findings marked **†** were surfaced and traced by the parallel review track
> and are cited to their `file:line`, but not every one was independently re-traced in the primary
> pass. The parallel security review independently reached the same top-line: **no P0/P1 auth
> bypass, SQL injection, cross-account read, or RCE** — every Drizzle query is a bound param, admin
> gating runs in both layers on all 13 `/api/admin/*` handlers, and the OTP/session crypto is sound.

---

## 1. Executive summary

**Overall health: strong.** This is a genuinely well-engineered codebase — better than most
production systems. Typecheck and lint are clean; the 638 jsdom component/full-stack tests pass.
The "never throw in-domain" discipline is applied *consistently* (not just documented), the
server-controlled `mode`/`model`/`images` invariants are airtight, the auth crypto is correct in
every detail checked, and the provider seam is a real abstraction rather than a leaky one. The
code comments are unusually honest about their own trade-offs.

The most important things to fix, in order:

1. **Guest abuse is effectively unbounded (P1).** The rate limiter and OTP throttle key on the
   *leftmost* `X-Forwarded-For` hop, which is client-controlled on the documented Fly deploy. A
   guest rotating that header gets a fresh bucket every request → the 20/60s guest cap is bypassed
   → uncapped xAI token spend and uncapped `turn_record` growth.
2. **Two in-memory maps grow without bound (P2), and #1 is the amplifier.** The guest session store
   and the rate-limit window store are both keyed by client-supplied values (`session_id` /
   spoofed IP) and are *never* evicted by count or TTL. On the 512 MB Fly machine this is a direct
   OOM vector.
3. **The primary model's end-to-end path isn't in the gating eval (P2).** The deterministic CI
   subset drives the loop through a scripted *Anthropic* client, but Grok is the production default.
   The Grok transcript flatten/echo and single-shot arg streaming are only unit-tested, never
   exercised through the full loop in the subset.
4. **`estimate_damage` is a coarser approximation than the app's "battle-math" identity implies
   (P2).** It's honestly flagged `is_estimate`, but it omits the in-game per-step flooring, so the
   reported min–max range can be off by a few HP.
5. **A cluster of user-visible state bugs (P2/P3):** a Showdown paste with an out-of-range `level`
   silently wipes the *entire* imported team (U1), follow-up chips clicked mid-stream orphan the
   in-flight turn (U2), and optimistic delete never reconciles on failure (U3).

---

## 2. Findings by area

### Security

#### S1 — `X-Forwarded-For` leftmost-hop trust defeats the guest rate limit (and OTP per-IP throttle). **P1. CONFIRMED.**

`web/src/app/api/chat/route.ts:124-133` and `web/src/app/api/auth/_lib/http.ts:58-67` both derive
the client IP as `xff.split(",")[0]`. The Fly edge (per `web/fly.toml`) *appends* the true client
IP to any client-supplied `X-Forwarded-For`, so the leftmost element is attacker-chosen.

- **Failure scenario:** a guest sends `X-Forwarded-For: <random>` on each `POST /api/chat`. Every
  request maps to a new `ip:<random>` bucket, so `checkRateLimit` always sees a fresh window and
  returns `allowed`. The 20/60s guest cap — the *only* abuse bound for anonymous users — never
  fires. Each turn runs a full Grok tool-loop (up to 14 iterations) and writes a `turn_record`
  retained indefinitely. Result: unbounded model spend + unbounded DB growth from one anonymous
  client.
- **Secondary:** the per-IP OTP *verify* throttle (`checkVerifyThrottle(ip)`) is likewise
  bypassable, though the per-code 5-attempt DB lockout and per-email issuance throttle still bound
  actual OTP brute-force, so the auth impact is limited.
- **Fix:** on Fly, read `Fly-Client-IP` (the edge-set true client address), or take the *rightmost*
  XFF hop (the one the trusted proxy appended). Make the trusted-hop count explicit rather than
  assuming a single proxy. **Blast radius:** two small helper functions; no contract impact.

#### S2 — `Content-Length` DoS guard is bypassable via chunked transfer. **P3. CONFIRMED.**

`route.ts:175-178`: `Number(req.headers.get("content-length"))` is `Number(null) === 0` when the
header is absent (chunked encoding), which is finite and `≤ MAX_REQUEST_BYTES`, so the guard passes
and `await req.json()` buffers the whole body. `validateImages` caps decoded image bytes, but a
text-only request with a multi-hundred-MB `message` string is fully buffered before the 2000-char
cap is checked (the cap runs in `checkRateLimit`, after parse).

- **Fix:** enforce a hard byte ceiling while reading the body (stream-count), not only via the
  declared `Content-Length`. Low severity — undici has its own limits and the app is low-traffic —
  but worth closing alongside S1.

#### S3 — Guest conversation history is keyed solely by client-supplied `session_id`, no secret binding. **P3. CONFIRMED †.**

`web/src/server/session-store.ts:74-91` stores/reads guest history by the raw `session_id` from the
request body (`parseBody`, `chat/route.ts:146-162`), with no per-guest secret. Anyone who learns or
guesses another guest's `session_id` can resume it — prior turns feed the model prompt, so earlier
context can surface in the attacker's answers. Bounded in practice (random client UUIDs, ephemeral,
no raw-history read endpoint), and signed-in history is properly account-scoped and unaffected.

#### S4 — `verify` echoes the raw session token in the JSON body. **Informational. CONFIRMED †.**

`web/src/app/api/auth/verify/route.ts:61-67` returns the raw 30-day session `token` in the response
body *in addition* to the httpOnly cookie — deliberate for the iOS Bearer client (ADR-2). Caveat:
any JS on the web origin can read it from the fetch response; if the web SPA ever persisted it (e.g.
localStorage) it would defeat the httpOnly protection. Confirm the web client discards the body
token (it's documented to).

#### Verified-good on security

- OTP: `crypto.randomInt` over the full 6-digit range, HMAC-SHA256 keyed by `AUTH_SECRET` (not a
  bare digest), length-guarded `timingSafeEqualHex`, 5-attempt lockout checked *before* the compare,
  single-use consume, non-enumerating `requestCode` (`otp.ts`, `auth-service.ts`).
- Sessions: 256-bit CSPRNG token, only the SHA-256 hash stored, cookie `httpOnly` + `SameSite=Lax`
  + `Secure` in prod, 30-day fixed window, lazy expiry cleanup (`sessions.ts`).
- Admin gating is genuinely two-layer (per-route `requireAdminRequest` + the `app/admin/layout.tsx`
  server-component gate), safe-default-dark on unset `ADMIN_EMAILS`, allowlist trimmed+lowercased
  (`admin.ts`).
- IDOR: every account-scoped repo takes `accountId` and filters by it; not-owned is indistinguishable
  from missing (404/null), no existence leak — verified in `conversation-repo.ts`, `team-repo.ts`,
  `conversations/[id]/route.ts`, `get-team.tool.ts`.

### Correctness & robustness

#### C1 — Unbounded in-memory stores. **P2. CONFIRMED.**

`web/src/server/session-store.ts`: `getStore()` is a `Map` on `globalThis`. `trim()` only shrinks a
session's array; nothing deletes a session key. `clearSession` exists but the chat route never calls
it. Every distinct guest `session_id` that ever chats leaves a permanent entry until process restart.
`web/src/server/rate-limit.ts` has the same shape: `store.set` overwrites on a fresh/expired window
but never deletes keys for IPs that don't return.

- **Failure scenario:** combined with S1, an attacker rotating `session_id` + spoofed IP grows both
  maps without bound → memory exhaustion on the 512 MB machine (whose health check deliberately
  avoids restarting on DB blips, so the OOM is the failure).
- **Fix:** bound both with an LRU cap + idle TTL sweep. **Blast radius:** contained to the two store
  modules.

#### C2 — `estimate_damage` omits in-game per-step flooring. **P2. CONFIRMED (disclosed).**

`web/src/agent/formulas/estimate-damage.ts:106-115` computes `modified = base * STAB * type * other`
then `min = floor(modified*0.85)`, `max = floor(modified*1.0)`. The real Gen-9 formula floors after
*each* of roll → STAB → type: `floor(floor(floor(base*0.85)*1.5)*2)`. For high multipliers
(STAB + ×4) the two diverge by a few HP, and the reported *range width* is slightly overstated.

- This matches the tool's own documented spec and is flagged `is_estimate: true`, so it is not a
  silent bug. But for an app whose defining trait is "reasoning on top of data / battle math,"
  closing this gap (apply per-step flooring in game order) is worth it — a "does it survive?" answer
  can flip on a 1–2 HP boundary. **Blast radius:** the pure function + its tests; output shape
  unchanged.

#### C3 — Unguarded `JSON.parse` on stored answers in the history GET. **P3. PLAUSIBLE.**

`conversations/[id]/route.ts:57`: `JSON.parse(t.answerJson)` is not wrapped, so a corrupted row 500s
the whole conversation load. The chat route's equivalent walk-back (`route.ts:358`) *is* try/caught.
The write path always `JSON.stringify`s a validated `OakAnswer`, so corruption is unlikely — but the
inconsistency means one bad row bricks a thread instead of degrading. **Fix:** guard the parse and
skip the bad turn.

#### C5 — `championsbattledata` index cache is poisonable by a single degraded 200 for 24h. **P3. PLAUSIBLE †.**

`web/src/server/champions-usage/usage-client.ts:183-197`: `getIndex` caches
`extractNames(raw.pokemon)` for 24h with no non-empty/sanity check. A momentary upstream `200 {}` or
`{pokemon:[]}` caches `names: []` for 24h → every `resolveSavedName` misses → usage lookups broadly
break until the TTL expires or the process redeploys. Hard transport errors correctly do *not* cache
(they throw before the cache write); the poison window is specifically "200 with an empty/garbage
body." *Fix:* require `names.length > 0` before caching, or use a short negative-TTL.

#### C6 — `readSseStream` doesn't flush the `TextDecoder` and frames only on `\n\n`. **P3. CONFIRMED † (robustness).**

`web/src/lib/sse/sse-client.ts:112-153`: `decode(value, {stream:true})` is correct mid-stream, but on
`done` it processes only the decoded buffer with no final `decoder.decode()` to flush a trailing
partial multibyte sequence, and framing splits solely on `"\n\n"` — a `\r\n\r\n` server (an
intermediary rewriting EOLs) would never frame. Safe *today* because it's paired with this exact
server (`formatSseEvent` emits `\n\n` and terminal frames end in ASCII), and `parseFrame` itself is
`\r`-tolerant. Fine now, fragile if the transport ever changes; the doc comment already flags the
`\n\n`-only choice as intentional.

#### C4 — `enrich-answer` nullish vs falsy inconsistency. **P3. CONFIRMED.**

`web/src/agent/enrich-answer.ts:144` uses `row.sprite_url ?? ref.sprite_url` for candidates, but
`:167` uses `s.sprite_url || ref.sprite_url` for subjects. A model that emits `sprite_url: ""` on a
candidate row keeps the empty string (no sprite) rather than backfilling. Minor — models rarely emit
`""` — but the two paths should use the same falsy check.

### Frontend & UX state

These are chat-UI / optimistic-update correctness bugs surfaced by the parallel API review.

#### U1 — Showdown import: an out-of-range `level` silently wipes the ENTIRE team. **P2. CONFIRMED †.**

`web/src/app/api/teams/import/route.ts:50-60,91-93`: `clampMember` clamps EV/IV to 0..255 but **not**
`level`; `importPaste` passes `set.level` verbatim (`import-export.ts:276-279`); `teamMemberSchema`
requires `level` in 1..100 (`team-schema.ts:64`). A paste containing `Level: 0`, `Level: 150`, or a
negative level fails `safeParse` → the fallback path returns `members: []` as a **200 with no note**.
`level` is the sole post-clamp field that can nuke the whole import.
- *Fix:* clamp `level` (or drop just that member with an `ImportNote`) instead of discarding the team.
- *Note:* the reviewer initially suspected a ">6 members → silent empty team" vector and **disproved
  it** — `parseShowdown` caps at `MAX_SETS=6` before mapping, so the member-count path is safe.

#### U2 — Follow-up chips on an earlier answer while streaming orphan the in-flight user turn. **P3. CONFIRMED †.**

The composer is disabled while streaming (`page.tsx:533`), but committed assistant turns always
render and their suggestion/candidate chips call `onFollowUp → handleSend` (`ChatThread.tsx:199`),
which is **not** status-gated. Clicking a chip mid-stream runs `handleSend` (`page.tsx:240-272`):
it appends a new user turn and `send()` aborts the in-flight stream, so the prior turn's user bubble
stays in `turns[]` but its answer never commits (the commit gate at `page.tsx:225-232` never fires) →
an orphaned user turn with no answer. Empty-state chips are idle-only and safe; answer-card chips
are not. *Fix:* status-gate the answer-card follow-up affordances too.

#### U3 — Optimistic delete never reconciles on failure. **P3. CONFIRMED †.**

`use-conversations.ts:97-100` and `use-teams.ts:107-110`: `remove` filters the row out locally, then
`await apiDelete(id)` and **ignores the result** with no `refresh()`. The API clients never throw, so
a failed DELETE (a transient 5xx folded to `false`) leaves the item gone from the UI but still in the
DB, resurfacing on the next unrelated re-list. Contrast `rename`, which does `if (!ok) refresh()`.

#### U4 — Optimistic rename can be clobbered by a concurrent list refetch. **P3. PLAUSIBLE †.**

`use-conversations.ts:75-84`: `rename` updates state optimistically. The list-fetch effect
(`:58-73`) re-runs on `refreshTick`, and `refresh()` fires after every completed turn (`page.tsx:236`)
and every pin. A refetch launched before the rename commits but resolving after it still has its own
`active === true` (a different effect instance), so it overwrites with pre-rename titles until the
next refetch. The `active` token orders within the fetch effect, not against imperative mutations.

### Data & schema

The ingest replace path is sound: build-all-in-memory then `DELETE` + chunked `INSERT` at 500
rows/chunk (well under the 65535 bind-param cap), `ingest_meta` written last so index-availability
flips at the end, `count(*)`/`count(distinct)` coerced via `.mapWith(Number)`, `ilike` used
deliberately for Postgres case-insensitivity. All correct and well-reasoned.

#### D1 — Per-table transactions, not one transaction across tables. **P3. CONFIRMED (low impact).**

`web/src/ingest/run.ts:228-238` calls `replaceTable` once per table, each its own transaction. A
crash between `pokemon` and `learnset` leaves a mixed state that is *queryable* (the `ingest_meta`
row from the prior run still exists, so `queryPokedex` doesn't gate it out). Idempotent re-run fixes
it, and ingest is an offline operator command, so impact is low — but a single wrapping transaction
(or writing `ingest_meta` as the availability gate *and* clearing it first) would make a partial
ingest invisible rather than served.

#### D1b — `listConversations` has no `LIMIT`/pagination and is refetched after every turn. **P3 (P2 at scale). CONFIRMED †.**

`conversation-repo.ts:92-134` has no `.limit()`; `route.ts:33-35` passes it through. The client
refetches on mount, on every debounced keystroke, on format change, and via `refresh()` — which
`page.tsx:236` fires after *every* completed turn (plus pin/rename). With `?q=`, it adds a correlated
`EXISTS(... ILIKE '%q%')` per row (`conversation-repo.ts:106-118`), a full text scan (no trigram
index in evidence). So a heavy user re-pulls the entire summary list — and runs the EXISTS scan per
message — once per turn: O(all-conversations) work per turn. Fine for a single user, grows poorly.
The isolation/escaping here is correct (`likePattern` escapes `% _ \`, `:79-81`).

#### D2 — `appendTurnPair`'s `SELECT … FOR UPDATE` does not serialize *first-turn* creation. **P3. CONFIRMED †ᵐ (mechanism).**

`conversation-repo.ts:211-237`: on the first turn the conversation row doesn't exist yet, so
`FOR UPDATE` locks nothing (Postgres locks matched rows only). Two concurrent first turns for the
same new `conversationId` both see `existing.length === 0`, both `INSERT`, and one hits the PK unique
violation → its transaction aborts → that turn is not persisted (logged as `chat_persist_failed`,
`route.ts:590-601`). Continuations are safe (row exists → `FOR UPDATE` blocks; the
`UNIQUE(conversation_id, seq)` index is the backstop). Narrow trigger: the SSE client aborts the
prior request and the route gates persistence on `req.signal.aborted`, so a single client is
sequential; the race needs the *same new* conversation id submitted from two tabs/devices at once.

#### D3 — `importConversation` idempotency breaks against server-appended rows. **P3. PLAUSIBLE †.**

`conversation-repo.ts:299-357` inserts message rows at `seq = i` (array index) with
`onConflictDoNothing({ target: conversation.id })`. After sign-in, `appendTurnPair` writes
server-minted UUIDs at `seq = MAX+1`. A later re-import of the full `turns[]` (sign out → in) carries
new client ids at `seq = i` that collide with the server rows on `UNIQUE(conversation_id, seq)` —
but `onConflictDoNothing` targets `id`, **not** `(conversation_id, seq)`, so the conflict is not
swallowed and the transaction throws (surfaced as a 500, folded to `null` by the history client)
where the doc comment promises "a re-import is a no-op." Holds only absent intervening server
appends.

### Testing & eval

The node/Testcontainers project could not be run at review time (no Docker daemon); jsdom is green
(638/638), typecheck and lint clean.

#### T1 — The primary model's end-to-end path is not in the gating eval. **P2. CONFIRMED.**

`web/eval/deterministic.ts` drives `runOakWith` with a scripted **Anthropic** client for all cases.
Grok is `DEFAULT_MODEL_KEY` and the production default. So the deterministic CI subset never
exercises the Grok provider's stream adaptation, the single-shot `function_call_arguments.done` →
`AnswerMarkdownExtractor` feed, or the `.flat()`/echo transcript logic through the *real loop*. There
are recorded-stream unit tests (`grok-provider.test.ts`), but a loop-level regression on the default
path could pass CI. Worth adding a Grok-scripted variant of the deterministic subset. The one
integration test that drives `runWithProvider` for xAI uses the OpenAI-compatible *shim*
(`OpenAICompatibleProvider {kind:"xai"}`, `enrich-answer.integration.test.ts:133-135`), **not** the
native `grok-provider.ts`, so the production Responses adapter's echo-flatten across iterations and
reasoning round-trip are never in a loop test. The deterministic subset is also standard-mode-only
(all 7 cases), so it doesn't guard Champions/format scoping through the runtime — that invariant is
covered at the repo layer (`pokedex-repo.test.ts`, `learnset-repo.test.ts`) and end-to-end for teams
(`active-team.integration.test.ts`), not at the eval gate.

#### T2 — The single `@pkmn` integration point has no test of real behavior. **P2. CONFIRMED †.**

`web/src/data/pkmn/gen-provider.ts` — where CLAUDE.md says every `@pkmn` quirk "lives" (legality
gates, Mega resolution, display-name → legacy-slug slugify) — is referenced only by
`build-pokedex.test.ts` / `build-names.test.ts`, both of which **mock** `@pkmn`. So those quirks are
validated only by a live `npm run ingest`, never in CI. This is the highest-leverage untested
boundary; a small smoke test asserting a few known slug/legality/Mega resolutions would guard it.
(`src/ingest/run.ts`'s DELETE-all + chunked-INSERT swap is likewise untested — the builders are
covered, the swap isn't.)

#### T3 — The LLM judge fails **open**. **P2. CONFIRMED †.**

`eval/judge.ts:471-482`: if the judge model doesn't call `submit_judgment`, all 5 dimensions default
to `score:1 / pass:true` → a broken or misconfigured judge yields false GREENs silently. Live-only
(the release gate, not the PR gate), but a one-line fix — treat "no tool call" as fail/indeterminate
— removes a real blind spot.

#### T4 — `mustInclude` is a plain substring match, so it passes on negation. **P3. CONFIRMED †.**

`judge.ts:210` uses `answer_markdown.includes(needle)`, so `mustInclude: ["immune"]` (G11) is
satisfied by "**not** immune". Only G11 has a compensating `.not.toContain(...)` guard in its own
test; the general checker doesn't. Consider a word-boundary/polarity-aware assertion.

#### Verified-good

`runStructural` (`eval/judge.ts`) asserts status, `minCandidates`, `mustCite` prefixes,
`mustInclude` substrings, tool-efficiency (brute-force `get_pokemon` guard scaled to result count),
citation-presence for factual answers, and fallback-generation correctness — real regression
catchers, not tautologies. The deterministic design is clever: answers are composed from *live*
fixture-DB tool output, so a tool regression genuinely fails the structural assertion. A missing plan
is a *failure*, not a skip (so the subset can't silently shrink).

### Maintainability & DX

#### M1 — Comment/constant drift. **P3. CONFIRMED.**

`runtime.ts:14` header says "Loop ≤ 10 iterations" but `MAX_ITERATIONS = 14` (`:87`).
`session-store.ts` comments reference "Sonnet 4.6" and "11 tool definitions"; `tools/index.ts`
header says "the 11 tool definitions in T1..T11 order" while the barrel exports 16. None are bugs,
but the internal contradictions (a header disagreeing with its own constant) will mislead the next
maintainer.

#### M2 — 14 `as unknown as OakDb` casts. **P3. CONFIRMED.**

The symptom of two repo handle conventions (raw `OakDb` vs `ctx.db.db`) papered over by
`bindDbCtx`'s self-referential non-enumerable `.db` property (`context.ts:97-108`). It works and is
documented, but it's a smell — see design note D2 below.

---

## 3. Design-level observations

**The provider seam is the best thing here.** Making the transcript `unknown[]` that the loop only
ever *pushes* into — never reads — is exactly the right cut. It's what lets one loop serve Anthropic
content-blocks, OpenAI `{role,content,tool_calls}`, and Grok Responses `input` items with identical
code. Do not change this.

**The Grok transcript flatten is the seam's one fragile spot.** `grok-provider.ts:163-173` relies on
the invariant that *the only array-valued elements in the transcript are the echoed `output[]`
arrays*, so a depth-1 `.flat()` inlines them correctly. That invariant is enforced only by
`buildUserMessage`/`buildToolResultMessages` happening to return non-array objects. It's documented,
but it's an implicit cross-method coupling a future change could silently violate. Prefer an explicit
tagged wrapper (`{ kind: "echo", items }`) that `streamTurn` unwraps, rather than "arrays are
special."

**Prompt parity is enforced by discipline, not tests.** CLAUDE.md is upfront that
`domain.ts`/`champions.ts` and `domain-grok.ts` must carry the same semantics and that the structure
tests can't catch semantic drift. A spot-check across nine anchors (`clarification_needed`,
`proposed_team`, `species clause`, `save_team`, etc.) didn't surface a real gap — the apparent
`get_usage_stats` asymmetry is just standard-vs-champions scoping — but this is a standing risk. A
lightweight semantic-parity checklist test (assert both bodies mention each tool name, each
hard-violation code, each status) would convert discipline into a guardrail.

**`AgentContext` mixes input and output.** `ctx.savedTeam` is a mutable result slot the tool writes
and the route reads back (`route.ts:556`). Pragmatic, but a context object that is also a return
channel is easy to misuse. A dedicated per-turn result accumulator would be cleaner; low priority.

**D2 — `bindDbCtx` / the dual handle contract.** Unify the two repo conventions on one (`ctx.db` is
the `OakDb`, full stop) rather than keep the self-reference hack + 14 casts. Cheap now, expensive
after more repos accrete.

**Where I'd have gone differently on state.** The in-memory guest store and rate-limit store are the
two places the "single always-on machine" assumption is load-bearing *and* unbounded. Given the app
already runs Postgres, either bound them hard (LRU+TTL) or push rate-limit state into Postgres/Redis.
Fine for one honest user, fragile for one dishonest one.

---

## 4. What's genuinely good (preserve these)

- **Never-throw-in-domain is real, not aspirational** — traced through every tool wrapper, both
  repos' error styles, and the runtime's per-tool try/catch that feeds faults back to the model
  instead of killing the turn.
- **Server-controlled invariants are airtight** — `mode`/`model`/`images`/`accountId` are never
  LLM-visible; `query_pokedex`, `get_team`, `save_team` all derive scope from `formatForMode(ctx.mode)`
  with no model-supplied override path.
- **`AnswerMarkdownExtractor`** (`runtime.ts:351-589`) is a careful hand-rolled streaming JSON-string
  decoder — handles escapes, `\uXXXX`, split surrogate pairs across chunks, and skips non-target
  values so a `reasoning_markdown` containing the literal `"answer_markdown"` can't misfire. Hard
  code done right.
- **SSE handling on both ends** — the route's guarded single-write path + heartbeat + `cancel()`
  cleanup, and the client's manual reader with `\n\n` frame splitting, cross-chunk buffer carry,
  `TextDecoder({stream:true})` for multi-byte UTF-8, and `reader.releaseLock()` in `finally`.
- **Prompt-cache byte-stability discipline** — text-only turns keep `content` a plain string; tool
  defs built once and never reordered; the reasoning behind every "don't touch this" is written down.

---

## 5. Open questions

- **Exact Fly XFF behavior.** S1 assumes Fly *appends* the true client IP (making the leftmost hop
  attacker-controlled). That's Fly's documented behavior, but deploy-dependent — confirm against the
  actual edge config, and prefer `Fly-Client-IP` regardless.
- **Does `npm test` (node/Testcontainers) pass in CI?** Not verified here (no Docker daemon). jsdom,
  typecheck, and lint are green.
- **Grok reasoning round-trip in practice.** The stateless `store:false` +
  `include:["reasoning.encrypted_content"]` echo path is well-reasoned in comments, but only read —
  whether xAI reliably accepts echoed reasoning items as input across multi-tool turns is something
  only a live run confirms (the `echoReasoning:false` escape hatch suggests the authors weren't 100%
  sure either).

---

## Appendix — severity legend

| Severity | Meaning |
|----------|---------|
| **P0** | Blocker — data loss, security breach, or broken core flow |
| **P1** | Serious — real abuse/cost/availability risk; fix soon |
| **P2** | Important — correctness/coverage gap worth scheduling |
| **P3** | Nice-to-have — polish, consistency, or low-impact hardening |

## Appendix — finding index

`†` = surfaced/traced by the parallel review track. Sorted by severity.

| ID | Severity | Status | Location |
|----|----------|--------|----------|
| S1 | P1 | CONFIRMED | `app/api/chat/route.ts:124-133`, `app/api/auth/_lib/http.ts:58-67` |
| C1 | P2 | CONFIRMED | `server/session-store.ts`, `server/rate-limit.ts` |
| C2 | P2 | CONFIRMED | `agent/formulas/estimate-damage.ts:106-115` |
| U1 | P2 | CONFIRMED † | `app/api/teams/import/route.ts:50-60,91-93`, `server/teams/import-export.ts:276-279` |
| T1 | P2 | CONFIRMED | `eval/deterministic.ts`, `enrich-answer.integration.test.ts:133-135` |
| T2 | P2 | CONFIRMED † | `data/pkmn/gen-provider.ts` (no real-behavior test) |
| T3 | P2 | CONFIRMED † | `eval/judge.ts:471-482` |
| S2 | P3 | CONFIRMED | `app/api/chat/route.ts:175-178` |
| S3 | P3 | CONFIRMED † | `server/session-store.ts:74-91` |
| S4 | info | CONFIRMED † | `app/api/auth/verify/route.ts:61-67` |
| C3 | P3 | PLAUSIBLE | `app/api/conversations/[id]/route.ts:57` |
| C4 | P3 | CONFIRMED | `agent/enrich-answer.ts:144,167` |
| C5 | P3 | PLAUSIBLE † | `server/champions-usage/usage-client.ts:183-197` |
| C6 | P3 | CONFIRMED † | `lib/sse/sse-client.ts:112-153` |
| U2 | P3 | CONFIRMED † | `components/chat/ChatThread.tsx:199`, `app/page.tsx:240-272` |
| U3 | P3 | CONFIRMED † | `lib/hooks/use-conversations.ts:97-100`, `use-teams.ts:107-110` |
| U4 | P3 | PLAUSIBLE † | `lib/hooks/use-conversations.ts:58-84` |
| D1 | P3 | CONFIRMED | `ingest/run.ts:228-238` |
| D1b | P3 | CONFIRMED † | `data/repos/conversation-repo.ts:92-134` |
| D2 | P3 | CONFIRMED † | `data/repos/conversation-repo.ts:211-237` |
| D3 | P3 | PLAUSIBLE † | `data/repos/conversation-repo.ts:299-357` |
| T4 | P3 | CONFIRMED † | `eval/judge.ts:210` |
| M1 | P3 | CONFIRMED | `runtime.ts:14,87`, `server/session-store.ts`, `agent/tools/index.ts` |
| M2 | P3 | CONFIRMED | `agent/context.ts:97-108` (14 call sites) |
