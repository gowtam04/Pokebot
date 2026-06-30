import Foundation
import Testing

@testable import OakApp

/// Drives the production ``SSEParser`` over the committed `.sse` chat-stream
/// fixtures and asserts it reconstructs the exact ``SSEEvent`` sequence — the
/// multi-frame full answer, the single-delta Grok case, the terminal `error`
/// frame, and a stream interleaved with `: keep-alive` heartbeat comments. Unlike
/// the fixture-only splitter in `SSEFixtureTests`, this exercises the real parser
/// the streaming client uses.
struct SSEParserTests {

  /// Runs every line of a fixture through one parser instance (mirroring how
  /// `SSEClient` feeds `URLSession.AsyncBytes.lines`, which strips newlines and
  /// yields blank lines as empty strings).
  private func parseEvents(in fixture: String) throws -> [SSEEvent] {
    let body = try Fixtures.string(fixture)
    var parser = SSEParser()
    var out: [SSEEvent] = []
    for line in body.components(separatedBy: "\n") {
      out.append(contentsOf: try parser.consume(line: line))
    }
    out.append(contentsOf: try parser.finish())
    return out
  }

  /// The full stream: two tool activities → reset → two deltas → terminal answer.
  @Test
  func fullAnswerStreamReconstructsExactSequence() throws {
    let events = try parseEvents(in: "chat_answered_full.sse")
    #expect(events.count == 6)

    guard case let .toolActivity(tool0, label0) = events[0] else {
      Issue.record("event 0 was not tool_activity: \(events[0])")
      return
    }
    #expect(tool0 == "resolve_entity")
    #expect(label0 == "Resolving \"Garchomp\"")

    guard case let .toolActivity(tool1, _) = events[1] else {
      Issue.record("event 1 was not tool_activity: \(events[1])")
      return
    }
    #expect(tool1 == "get_pokemon")

    #expect(events[2] == .answerStart)

    guard case let .answerDelta(delta0) = events[3] else {
      Issue.record("event 3 was not answer_delta: \(events[3])")
      return
    }
    #expect(delta0 == "**Garchomp** is a Dragon/Ground ")

    guard case .answerDelta = events[4] else {
      Issue.record("event 4 was not answer_delta: \(events[4])")
      return
    }

    guard case let .answer(answer) = events[5] else {
      Issue.record("terminal event was not answer: \(events[5])")
      return
    }
    #expect(answer.status == .answered)
    #expect(answer.subjects?.first?.name == "Garchomp")
    #expect(answer.subjects?.first?.dexNumber == 445)
  }

  /// The Grok case: a single delta carries the whole markdown before the answer.
  @Test
  func grokSingleDeltaStreamHasOneDelta() throws {
    let events = try parseEvents(in: "chat_single_delta_grok.sse")
    #expect(events.count == 3)
    #expect(events[0] == .answerStart)

    guard case let .answerDelta(text) = events[1] else {
      Issue.record("event 1 was not answer_delta: \(events[1])")
      return
    }
    #expect(text.contains("Dragapult"))

    guard case let .answer(answer) = events[2] else {
      Issue.record("terminal event was not answer: \(events[2])")
      return
    }
    #expect(answer.status == .answered)
  }

  /// A transport-fault stream ends with an `error` event carrying code + status.
  @Test
  func errorStreamYieldsErrorEvent() throws {
    let events = try parseEvents(in: "chat_error.sse")
    #expect(events.count == 2)

    guard case .toolActivity = events[0] else {
      Issue.record("event 0 was not tool_activity: \(events[0])")
      return
    }

    guard case let .error(code, message, status) = events[1] else {
      Issue.record("terminal event was not error: \(events[1])")
      return
    }
    #expect(code == "model_unavailable")
    #expect(message.isEmpty == false)
    #expect(status == 503)
  }

  /// `: keep-alive` heartbeat comments interleaved between frames are skipped; only
  /// the real events (tool activity → reset → delta → terminal answer) come through.
  @Test
  func heartbeatCommentsAreSkipped() throws {
    let events = try parseEvents(in: "chat_heartbeat.sse")
    #expect(events.count == 4)

    guard case .toolActivity = events[0] else {
      Issue.record("event 0 was not tool_activity: \(events[0])")
      return
    }
    #expect(events[1] == .answerStart)

    guard case .answerDelta = events[2] else {
      Issue.record("event 2 was not answer_delta: \(events[2])")
      return
    }

    guard case let .answer(answer) = events[3] else {
      Issue.record("terminal event was not answer: \(events[3])")
      return
    }
    #expect(answer.status == .answered)
  }

  /// Incremental feeding across multiple `data:` lines and a comment mid-frame is
  /// parsed correctly, and the parser is reusable for the next frame.
  @Test
  func incrementalFeedHandlesCommentsAndReuse() throws {
    var parser = SSEParser()
    var out: [SSEEvent] = []
    let lines = [
      ": keep-alive",
      "event: tool_activity",
      "data: {\"tool\":\"get_pokemon\",\"label\":\"Looking up\"}",
      "",
      "event: answer_start",
      "data: {}",
      "",
    ]
    for line in lines {
      out.append(contentsOf: try parser.consume(line: line))
    }
    #expect(out.count == 2)
    guard case let .toolActivity(tool, _) = out[0] else {
      Issue.record("first event was not tool_activity: \(out[0])")
      return
    }
    #expect(tool == "get_pokemon")
    #expect(out[1] == .answerStart)
  }

  /// A recognized event whose JSON is malformed surfaces `OakError.decoding`.
  @Test
  func malformedKnownFrameThrowsDecoding() {
    #expect(throws: OakError.self) {
      var parser = SSEParser()
      _ = try parser.consume(line: "event: answer_delta")
      _ = try parser.consume(line: "data: {not json}")
      _ = try parser.consume(line: "")
    }
  }

  /// An unknown event name is ignored (forward-compatible with new server events).
  @Test
  func unknownEventNameIsIgnored() throws {
    var parser = SSEParser()
    var out: [SSEEvent] = []
    out.append(contentsOf: try parser.consume(line: "event: some_future_event"))
    out.append(contentsOf: try parser.consume(line: "data: {\"x\":1}"))
    out.append(contentsOf: try parser.consume(line: ""))
    #expect(out.isEmpty)
  }
}
