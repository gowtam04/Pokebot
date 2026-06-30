import Foundation
import Testing

@testable import OakApp

/// Guards the byte→line splitting that `SSEClient` performs on the live chat stream
/// (the layer that was silently broken). The earlier `SSEParserTests` feed the
/// parser lines via `components(separatedBy: "\n")` — which keeps empty lines — so
/// they never exercised the real failure: `URLSession.AsyncBytes.lines`
/// (`AsyncLineSequence`) DROPS empty lines, and SSE delimits each event with a
/// blank line. These tests drive RAW BYTES through ``ByteLineSplitter`` (the
/// production splitter `SSEClient` now uses) so the blank-line delimiters are
/// proven to survive end-to-end.
struct SSELineSplitTests {

  /// Feeds every byte of `data` through ``ByteLineSplitter`` exactly as
  /// `SSEClient.stream` does, returning the emitted lines (including empty lines).
  private func splitLines(_ data: Data) -> [String] {
    var splitter = ByteLineSplitter()
    var lines: [String] = []
    for byte in data {
      if let line = splitter.consume(byte) { lines.append(line) }
    }
    if let last = splitter.finish() { lines.append(last) }
    return lines
  }

  /// The core property `bytes.lines` got wrong: consecutive newlines yield an empty
  /// line (the SSE frame delimiter), not nothing.
  @Test
  func preservesEmptyLinesBetweenNewlines() {
    #expect(splitLines(Data("a\n\nb\n".utf8)) == ["a", "", "b"])
    // A single SSE frame + its terminating blank line.
    #expect(splitLines(Data("event: x\ndata: {}\n\n".utf8)) == ["event: x", "data: {}", ""])
  }

  /// Multi-byte UTF-8 (emoji in a tool label) survives — `0x0A` never appears inside
  /// a UTF-8 continuation byte, so each line decodes whole.
  @Test
  func splitsUTF8Cleanly() {
    #expect(splitLines(Data("🤔 Reasoning…\n".utf8)) == ["🤔 Reasoning…"])
  }

  /// A final line with no trailing newline is flushed by `finish()`.
  @Test
  func flushesUnterminatedFinalLine() {
    #expect(splitLines(Data("tail".utf8)) == ["tail"])
  }

  /// End-to-end regression: drive the recorded multi-frame stream through the SAME
  /// splitter `SSEClient` uses (NOT `components(separatedBy:)`), then the production
  /// `SSEParser`, and assert the terminal `answer` decodes. This is the exact path
  /// that failed under `bytes.lines` (the blank delimiters were dropped, so every
  /// `data:` payload concatenated and the answer threw `OakError.decoding`).
  @Test
  func rawByteStreamReconstructsTerminalAnswer() throws {
    let data = try Fixtures.data("chat_answered_full.sse")
    let lines = splitLines(data)
    // Blank-line frame delimiters must survive the split (the whole point).
    #expect(lines.contains(""))

    var parser = SSEParser()
    var events: [SSEEvent] = []
    for line in lines {
      events.append(contentsOf: try parser.consume(line: line))
    }
    events.append(contentsOf: try parser.finish())

    #expect(events.count == 6)
    guard case let .answer(answer) = events.last else {
      Issue.record("last event was not .answer: \(String(describing: events.last))")
      return
    }
    #expect(answer.status == .answered)
  }
}
