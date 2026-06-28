# Integration

How the agent plugs into the surrounding system. The architect will formalize
these seams; this is the contract they must satisfy.

## Invocation Signature

The web backend exposes a chat endpoint that drives the agent:

```
POST /api/chat
Request:  { "session_id": string, "message": string,
            "images"?: { "mimeType": string, "data": string }[] }  // ≤ 4, base64
Response: streamed — tool-activity progress events, then a final
          { "answer": OakAnswer }   (see output-formats.md)
```

Internally the agent runs behind a single function:

```ts
async function runOak(
  message: string,
  history: ChatMessage[], // in-session prior turns (D9)
  ctx: AgentContext, // tool clients (index, cache), logger, request id
): Promise<OakAnswer>;
```

- The loop: build the cached prefix (system + tools + few-shot) → append history
  - `message` → run the Sonnet 4.6 tool-loop (max 10 iterations) → return the
    `submit_answer` payload.
- `history` is supplied by the session store (in-memory; in-session only). No DB.

## Input Contract

| Field        | Used by the agent                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `message`    | The user's question — the primary input. MAY be empty when `images` is present (an image-only "what is this?" upload). |
| `images`     | Up to 4 images attached to THIS turn, reasoned about by the model directly (general vision — team screenshots, a Pokémon to ID, a damage-calc, etc.). **Consume-on-turn**: validated + MIME-sniffed by the route, bound onto `AgentContext.images`, and handed straight to the model in the current user message — NOT stored in history. The model decides what the image is; it is never routed through a content-specific parser. A team screenshot's extracted `proposed_team` carries forward via the existing `answer_json` path. |
| `history`    | Prior turns this session, for multi-turn refinement (US-10). The agent reads the prior candidate set / topic from here. Text only — images are not replayed (re-attach to revisit a non-team image). |
| `session_id` | Orchestration only (routing to the right in-memory history); not seen by the model.                                     |

## Output Contract

The return value is a validated `OakAnswer` (`output-formats.md`). The route
wraps it as `{ "answer": <OakAnswer> }`. If `submit_answer`'s payload fails
schema validation, orchestration returns the validation error to the model and
requests one re-emit (max 1–2 retries) before surfacing a generic
`insufficient_data` answer to the user.

## UI Consumer Contract

The frontend `AnswerCard` renders the payload field-by-field (mapping table in
`output-formats.md` → Consumer Contract). Key points:

- **Type badges:** every `types[]` value is one of the 18 enum names; the
  frontend owns the name→color map (and the `frontend-design` skill will define
  the palette).
- **Sprites:** `subjects[].sprite_url` / `candidates.shown[].sprite_url` come from
  the index (PokeAPI sprite URLs) — the frontend just renders them.
- **UI → agent events:** clicking a `suggestions[]` chip or a candidate row sends
  a **normal follow-up user message** (e.g. "Will-O-Wisp", "tell me about
  Ceruledge") to `POST /api/chat` with the same `session_id`. There is no special
  event protocol — every interaction is a chat turn (see `ux-design.md`).
- **Progress:** while the loop runs, stream tool-activity labels ("🔍 resolving…",
  "📊 querying Pokédex…", "🧮 computing stat…") so the UI shows motion; render the
  `AnswerCard` when the final `answer` arrives.

## Error Surface

| Condition                                       | Caller sees                                                        | Handling                           |
| ----------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| Entity unresolved                               | `OakAnswer` with `status: "resolution_failed"` + `suggestions` | Normal render (not an HTTP error). |
| Need clarification                              | `status: "clarification_needed"`                                   | Normal render.                     |
| PokeAPI / cache down on a needed fetch          | `status: "insufficient_data"` + `uncertainty_flags`                | Normal render; user told plainly.  |
| Index unavailable                               | `status: "insufficient_data"`                                      | Same.                              |
| Loop hit max iterations without `submit_answer` | Orchestration synthesizes an `insufficient_data` answer            | Log as an anomaly.                 |
| `submit_answer` invalid after retries           | Generic `insufficient_data` answer                                 | Log validation error.              |
| Model/API transport error or timeout            | HTTP 5xx to the route; frontend shows a retry affordance           | Outside the answer schema.         |

## Observability Hooks (dev-team to implement)

Per turn, log: `request_id`, `session_id`, model id, input/output/thinking
tokens, **the full tool-call trace** (tool, args, latency, cache hit/miss,
error), total turn latency, final `status`, and citation count. This trace is
also what the eval harness and prod-sampling (G-cases) consume.

## Guardrails Outside the Agent (orchestration, not prompt)

- **Input length cap** on `message` (reject/truncate absurd inputs).
- **PokeAPI fair-use throttle** in the cache/ingest layer (rate limit + cache;
  BR-8) — the agent never calls PokeAPI directly, so this lives entirely in the
  cache layer.
- **Per-session rate limit** (even single-user) to bound runaway loops / cost.
- **Max tool iterations** (10) enforced by the loop, independent of the prompt.
- No PII / auth guardrails needed (none present).

## Runtime / Stack (deferred to architect)

Open items for `solution-architect` (do **not** decide here):

- Language/runtime (TS server is the natural fit given a web frontend; confirm).
- Where `runOak` lives (API route vs. service module) and the streaming
  mechanism (SSE vs. WebSocket).
- The **cache/index ingest pipeline** (Dependency 4 in `overview.md`) — storage
  choice (embedded DB vs. in-memory + JSON snapshot), rebuild cadence/trigger.
- Frontend framework + the `AnswerCard` component tree.
- SDK-level specifics (prompt-cache config, tool-loop, `tool_choice` to force
  `submit_answer`, streaming) — handled by `dev-team` via the `claude-api` skill.
