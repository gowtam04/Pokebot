import Foundation

/// Wire DTOs for `POST /api/chat` — the request body and the SSE event stream.
///
/// Faithful mirror of the TypeScript contract in `web/src/lib/sse/sse-types.ts`
/// (data-model.md "Wire DTOs"). The TS source is authoritative; if it changes,
/// these mirrors must change (a round-trip decode test guards the drift).
///
/// Mapping rule (conventions.md): the wire mixes conventions, so each type maps
/// fields with EXPLICIT `CodingKeys` rather than a global `.convertFromSnakeCase`
/// — e.g. `session_id`/`champions_mode` are snake_case but the image's `mimeType`
/// is intentionally camelCase on the wire.

// MARK: - Request

/// Request body for `POST /api/chat`.
///
/// Reconciliation (api-design.md): there is NO `active_team_id` on this body — the
/// active team is applied server-side and set via `PATCH /api/conversations/{id}`
/// (`HistoryService.setActiveTeam`). Do not add `activeTeamId` here.
struct ChatRequest: Encodable, Sendable {
    /// Client UUID for the thread; equals the conversation id on resume.
    let sessionId: String
    /// 0–2000 chars. MAY be empty when one or more `images` are present.
    let message: String
    /// Images attached to this turn (≤ 4). `nil` ⇒ a text-only turn.
    let images: [ChatImage]?
    /// Champions-mode toggle. `nil` ⇒ standard / Gen 9.
    let championsMode: Bool?

    private enum CodingKeys: String, CodingKey {
        case sessionId = "session_id"
        case message
        case images
        case championsMode = "champions_mode"
    }
}

/// One image attached to a chat message (wire shape).
///
/// `data` is RAW base64 with NO `data:` prefix. `mimeType` is the client's
/// best-effort declaration; the server re-sniffs the bytes by magic number to
/// determine the canonical MIME type.
struct ChatImage: Encodable, Sendable {
    /// Best-effort MIME type, e.g. `"image/jpeg"`. Intentionally camelCase on the wire.
    let mimeType: String
    /// RAW base64-encoded image bytes (no `data:` prefix).
    let data: String

    // `mimeType` stays camelCase on the wire by design — do NOT remap it.
    private enum CodingKeys: String, CodingKey {
        case mimeType
        case data
    }
}

// MARK: - SSE events

/// One decoded server-sent event from the chat stream.
///
/// The endpoint emits, in order: `tool_activity`* → `answer_start`*/`answer_delta`*
/// → exactly one terminal `answer` (authoritative). An `error` event is reserved
/// for transport/API faults ONLY — every in-domain failure (unresolved entity,
/// clarification, index missing, loop-max) rides a normal `answer` event whose
/// `OakAnswer.status` carries the failure.
///
/// `event:`-name decoding lives in `SSEParser`; this type only models the events
/// and (via the nested `*Data` payloads below) the way to decode each frame's
/// `data:` JSON.
enum SSEEvent: Sendable, Equatable {
    /// `tool_activity` — one per tool call, shown as progress while the loop runs.
    case toolActivity(tool: String, label: String)
    /// `answer_start` — re-emit reset: the client clears its in-flight markdown buffer.
    case answerStart
    /// `answer_delta` — one incremental chunk of `answer_markdown`.
    case answerDelta(text: String)
    /// `answer` — the single terminal, authoritative answer for the turn.
    case answer(OakAnswer)
    /// `error` — transport/API fault only (never an in-domain failure).
    case error(code: String, message: String, status: Int?)
}

extension SSEEvent {
    /// `event: tool_activity` data payload.
    struct ToolActivityData: Decodable, Sendable {
        let tool: String
        let label: String
    }

    /// `event: answer_delta` data payload.
    struct AnswerDeltaData: Decodable, Sendable {
        let text: String
    }

    /// `event: answer` data payload — wraps the terminal `OakAnswer`.
    struct AnswerData: Decodable, Sendable {
        let answer: OakAnswer
    }

    /// `event: error` data payload — transport faults only.
    struct ErrorData: Decodable, Sendable {
        let code: String
        let message: String
        /// Upstream HTTP status for a provider transport fault, when known.
        let status: Int?
    }

    // The `answer_start` frame carries an empty object `{}`; it has no payload
    // struct — the parser maps the bare event name straight to `.answerStart`.
}
