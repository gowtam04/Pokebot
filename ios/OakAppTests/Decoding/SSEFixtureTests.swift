import Foundation
import Testing

@testable import OakApp

/// Contract checks for the committed `.sse` chat-stream fixtures. The full
/// incremental byte parser (`SSEParser`) is a later networking phase; here the
/// goal is twofold: (1) prove every `.sse` fixture is bundled and readable (a
/// `project.yml` resource-wiring guard), and (2) decode each frame's `data:`
/// JSON into the matching `SSEEvent.*Data` DTO so the embedded payloads — most
/// importantly the terminal `answer`'s `OakAnswer` — are contract-valid.
///
/// The frame splitter below is a fixture-only helper, deliberately minimal; it is
/// NOT the production streaming parser.
struct SSEFixtureTests {

  /// One parsed SSE frame: its `event:` name and raw `data:` JSON text.
  private struct Frame {
    let event: String
    let dataJSON: String
  }

  /// Split a recorded `.sse` body into non-comment frames. Blank-line-delimited;
  /// `:`-prefixed heartbeat comments are skipped (mirrors the parser contract).
  private func parseFrames(in fixture: String) throws -> [Frame] {
    let body = try Fixtures.string(fixture)
    var parsed: [Frame] = []
    for block in body.components(separatedBy: "\n\n") {
      let trimmed = block.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      if trimmed.hasPrefix(":") { continue }  // keep-alive heartbeat comment
      var event: String?
      var data: String?
      for rawLine in trimmed.split(separator: "\n", omittingEmptySubsequences: true) {
        let line = String(rawLine)
        if line.hasPrefix("event:") {
          event = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
        } else if line.hasPrefix("data:") {
          data = String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces)
        }
      }
      let resolvedEvent = try #require(event, "frame missing event: \(trimmed)")
      let resolvedData = try #require(data, "frame missing data: \(trimmed)")
      parsed.append(Frame(event: resolvedEvent, dataJSON: resolvedData))
    }
    return parsed
  }

  /// Every `.sse` fixture is present in the test bundle and non-empty.
  @Test(arguments: sseFixtures)
  func everySSEFixtureIsBundledAndNonEmpty(_ name: String) throws {
    let text = try Fixtures.string(name)
    #expect(text.isEmpty == false)
  }

  /// A full stream: tool_activity* → answer_start → answer_delta* → answer. Each
  /// frame's payload decodes into its DTO, and the terminal answer is a valid
  /// `OakAnswer`.
  @Test
  func answeredFullStreamDecodesEveryFramePayload() throws {
    let frames = try parseFrames(in: "chat_answered_full.sse")
    #expect(frames.last?.event == "answer")

    var toolActivities = 0
    var deltas = 0
    var terminalAnswers = 0
    for frame in frames {
      let data = Data(frame.dataJSON.utf8)
      switch frame.event {
      case "tool_activity":
        let payload = try JSONDecoder().decode(SSEEvent.ToolActivityData.self, from: data)
        #expect(payload.tool.isEmpty == false)
        #expect(payload.label.isEmpty == false)
        toolActivities += 1
      case "answer_start":
        #expect(frame.dataJSON == "{}")
      case "answer_delta":
        let payload = try JSONDecoder().decode(SSEEvent.AnswerDeltaData.self, from: data)
        #expect(payload.text.isEmpty == false)
        deltas += 1
      case "answer":
        let payload = try JSONDecoder().decode(SSEEvent.AnswerData.self, from: data)
        #expect(payload.answer.status == .answered)
        #expect(payload.answer.subjects?.first?.name == "Garchomp")
        terminalAnswers += 1
      default:
        Issue.record("unexpected event \(frame.event)")
      }
    }
    #expect(toolActivities == 2)
    #expect(deltas == 2)
    #expect(terminalAnswers == 1)
  }

  /// The Grok case: the answer markdown arrives in a SINGLE delta before the
  /// terminal answer.
  @Test
  func grokSingleDeltaStreamHasOneDelta() throws {
    let frames = try parseFrames(in: "chat_single_delta_grok.sse")
    let deltas = frames.filter { $0.event == "answer_delta" }
    #expect(deltas.count == 1)
    let answerFrame = try #require(frames.last)
    #expect(answerFrame.event == "answer")
    let payload = try JSONDecoder().decode(
      SSEEvent.AnswerData.self,
      from: Data(answerFrame.dataJSON.utf8)
    )
    #expect(payload.answer.status == .answered)
  }

  /// A transport-fault stream: the terminal frame is an `error` carrying a code,
  /// message, and upstream status.
  @Test
  func errorStreamDecodesErrorPayload() throws {
    let frames = try parseFrames(in: "chat_error.sse")
    let errorFrame = try #require(frames.last)
    #expect(errorFrame.event == "error")
    let payload = try JSONDecoder().decode(
      SSEEvent.ErrorData.self,
      from: Data(errorFrame.dataJSON.utf8)
    )
    #expect(payload.code == "model_unavailable")
    #expect(payload.message.isEmpty == false)
    #expect(payload.status == 503)
  }

  /// Heartbeat comments (`: keep-alive`) are present in the raw stream but are
  /// skipped by the frame splitter, leaving only real events.
  @Test
  func heartbeatCommentsArePresentButSkipped() throws {
    let raw = try Fixtures.string("chat_heartbeat.sse")
    #expect(raw.contains(": keep-alive"))

    let frames = try parseFrames(in: "chat_heartbeat.sse")
    #expect(frames.contains { $0.event == "answer" })
    // No comment leaked through as an event.
    #expect(frames.allSatisfy { !$0.event.isEmpty && !$0.event.hasPrefix(":") })

    let answerFrame = try #require(frames.last)
    let payload = try JSONDecoder().decode(
      SSEEvent.AnswerData.self,
      from: Data(answerFrame.dataJSON.utf8)
    )
    #expect(payload.answer.status == .answered)
  }
}

/// Every committed `.sse` chat-stream fixture.
private let sseFixtures: [String] = [
  "chat_answered_full.sse",
  "chat_single_delta_grok.sse",
  "chat_error.sse",
  "chat_heartbeat.sse",
]
