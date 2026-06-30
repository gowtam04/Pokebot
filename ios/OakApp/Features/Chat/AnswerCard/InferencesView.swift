import SwiftUI

/// Renders an answer's `inferences[]` — claims Oak *deduced* rather than read
/// directly from data (BR-3 / M-AC-1.2). Each row shows the claim, a confidence
/// level (`high`/`medium`/`low`), and an optional note on what the deduction
/// hinges on.
///
/// Styling mirrors the web `InferenceCallout`: a soft azure fill with a **dashed**
/// azure border — the dashed edge is the visual signal for "inferred, not cited",
/// keeping it distinct from the solid uncertainty caveat strip. Confidence is
/// carried by an icon (a fill-level meter) **and** a text label, not color alone
/// (M-AC-UI9.3); colors and type ramp adapt to light/dark + Dynamic Type and wrap
/// rather than clip at large sizes (M-AC-1.4, M-UI-US-9).
///
/// Renders nothing when there are no inferences.
struct InferencesView: View {
  let inferences: [Inference]

  var body: some View {
    if !inferences.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        Label("Inferred", systemImage: "lightbulb")
          .font(Theme.display(.subheadline))
          .foregroundStyle(Theme.azure)
          .accessibilityLabel("Inferred — deductions, not cited")

        ForEach(Array(inferences.enumerated()), id: \.offset) { _, inference in
          row(inference)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(12)
      .background(
        Theme.azure.opacity(0.10),
        in: RoundedRectangle(cornerRadius: Theme.Radius.md)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.Radius.md)
          .strokeBorder(
            Theme.azure.opacity(0.5),
            style: StrokeStyle(lineWidth: 1, dash: [4, 3])
          )
      )
    }
  }

  /// One inference: a leading confidence badge, the claim, and an optional note.
  @ViewBuilder
  private func row(_ inference: Inference) -> some View {
    let confidence = inference.confidence

    HStack(alignment: .top, spacing: 8) {
      confidenceBadge(confidence)

      VStack(alignment: .leading, spacing: 2) {
        Text(inference.claim)
          .font(Theme.body(.subheadline))
          .foregroundStyle(Theme.textPrimary)
          .fixedSize(horizontal: false, vertical: true)

        if let note = inference.note, !note.isEmpty {
          Text(note)
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
      }

      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(accessibilityLabel(for: inference))
  }

  /// A capsule pairing the confidence's fill-level icon with its label — the icon
  /// + word carry the level so color is never the sole signal (M-AC-UI9.3).
  private func confidenceBadge(_ confidence: Inference.Confidence) -> some View {
    Label {
      Text(confidence.label.uppercased())
        .font(Theme.body(.caption2).weight(.semibold))
    } icon: {
      Image(systemName: confidence.systemImage)
        .imageScale(.small)
    }
    .foregroundStyle(confidence.tint)
    .padding(.horizontal, 8)
    .padding(.vertical, 3)
    .background(confidence.tint.opacity(0.15), in: Capsule())
  }

  private func accessibilityLabel(for inference: Inference) -> String {
    var label = "\(inference.confidence.label) confidence inference: \(inference.claim)"
    if let note = inference.note, !note.isEmpty {
      label += ". \(note)"
    }
    return label
  }
}

/// Presentation mapping for an inference's confidence level. A fill-level icon
/// (full / half / empty circle) plus a text label communicate the level so the
/// hue is reinforcement, not the only cue (M-AC-UI9.3).
private extension Inference.Confidence {
  var label: String {
    switch self {
    case .high: return "High"
    case .medium: return "Medium"
    case .low: return "Low"
    }
  }

  var systemImage: String {
    switch self {
    case .high: return "circle.fill"
    case .medium: return "circle.bottomhalf.filled"
    case .low: return "circle"
    }
  }

  var tint: Color {
    switch self {
    case .high: return Theme.success
    case .medium: return Theme.sunflower
    case .low: return Theme.textMuted
    }
  }
}

#if DEBUG
#Preview("Inferences") {
  InferencesView(
    inferences: [
      .init(
        claim: "Fake Out fails against Farigiraf because Inner Focus prevents flinching.",
        confidence: .high,
        note: "Inner Focus is one of Farigiraf's listed abilities."
      ),
      .init(
        claim: "Trick Room likely benefits this slow team more than fast leads.",
        confidence: .medium,
        note: nil
      ),
      .init(
        claim: "This spread may outspeed neutral-nature base 100s at +1.",
        confidence: .low,
        note: "Exact EV investment of the opponent is unknown."
      ),
    ]
  )
  .padding()
}

#Preview("Empty (renders nothing)") {
  InferencesView(inferences: [])
    .padding()
}
#endif
