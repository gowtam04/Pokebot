import SwiftUI

/// The top-level renderer for a single finalized ``OakAnswer`` — the native mirror
/// of the web `AnswerCard` (`web/src/components/answer-card/AnswerCard.tsx`). It
/// fans each field of the payload out to its mapped leaf subview, **invoking a
/// subview only when its field is present** (the render-if-present rule the whole
/// AnswerCard tree follows), in a single reading order (M-AC-1.2 / M-BR-CHAT-5 —
/// every field the web renders is represented; nothing is dropped for brevity):
///
///   1. status badge        ← non-`answered` outcomes only (M-AC-1.3)
///   2. answer markdown      ← `answer_markdown` (always)
///   3. subjects             ← `subjects[]`
///   4. clarify question     ← `question.options[]` — the "stop and ask" CTA
///   5. candidates           ← `candidates`
///   6. damage calc          ← `damage_calc`
///   7. team blocks          ← `proposed_team` / `saved_team` (+ warnings)
///   8. suggestions          ← `suggestions[]` (+ status)
///   9. reasoning            ← `reasoning_markdown` (collapsible)
///  10. citations            ← `citations[]` (collapsible "Sources")
///  11. inferences           ← `inferences[]`
///  12. generation basis     ← `generation_basis`
///  13. uncertainty flags    ← `uncertainty_flags[]`
///
/// The blocks render full-width on the chat background (no outer bubble): user
/// turns carry the colored bubble, the answer is the open, reasoned content, and
/// each structured block supplies its own card chrome — so there is no
/// surface-on-surface nesting.
///
/// Interactivity: a clarify-option or suggestion tap sends its text **verbatim**
/// as the next user turn via ``onFollowUp`` (the same UI→agent-input mechanism the
/// web uses). The team-block actions (``onApplyTeam`` / ``onOpenSavedTeam``)
/// default to no-ops here — Apply is wired in P10 and the saved-team open by the
/// artifact phase — so this orchestrator builds today and those phases attach a
/// handler without restructuring.
///
/// Which blocks render is exposed as the pure ``sections`` list so the orchestration
/// is unit-testable without a third-party view-inspection package (ADR-5): `body`
/// renders exactly `sections`, and the tests assert presence/absence/order over it.
struct AnswerCardView: View {
  let answer: OakAnswer

  /// Sends the given text verbatim as the next user turn (clarify options +
  /// suggestion chips). Defaults to a no-op so the card renders in isolation.
  var onFollowUp: (String) -> Void = { _ in }

  /// Saves a proposed team to the user's Teams. Wired in P10; no-op until then.
  var onApplyTeam: (ProposedTeam) -> Void = { _ in }

  /// Opens a saved team in the artifact viewer. Wired by the artifact phase; no-op
  /// until then.
  var onOpenSavedTeam: (SavedTeamRef) -> Void = { _ in }

  /// Opens an entity (a Pokémon shown as a subject) in the artifact viewer
  /// (M-ART-US-1). Only entities in a STRUCTURED part of the answer are openable
  /// (M-BR-ART-3). Defaults to a no-op so the card renders in isolation; the chat
  /// host wires it to ``ArtifactViewModel/openEntity(kind:query:)``.
  var onOpenEntity: (EntityKind, String) -> Void = { _, _ in }

  /// Opens the agent's proposed team in the artifact viewer using its INLINE data —
  /// no fetch (M-AC-A4.1). Defaults to a no-op; the chat host wires it to
  /// ``ArtifactViewModel/openProposedTeam(_:warnings:)``.
  var onOpenProposedTeam: (ProposedTeam, [TeamWarning]) -> Void = { _, _ in }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      ForEach(sections, id: \.self) { section in
        view(for: section)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    // The whole answer reads as one VoiceOver container with ordered children.
    .accessibilityElement(children: .contain)
  }

  // MARK: Section model (testable orchestration seam)

  /// One renderable block of the answer card. Each case maps 1:1 to a leaf subview
  /// (or, for `status`/`answer`, an inline element), so a test can assert which
  /// blocks an answer produces without inspecting the SwiftUI hierarchy.
  enum Section: Hashable {
    case status
    case answer
    case subjects
    case question
    case candidates
    case damageCalc
    case teams
    case suggestions
    case reasoning
    case citations
    case inferences
    case generationBasis
    case uncertainty
  }

  /// The ordered blocks this card renders for ``answer`` — the single source of
  /// truth `body` iterates. A block is included only when its field is present
  /// (and non-empty after the same trimming its subview applies), so an absent
  /// field renders nothing.
  var sections: [Section] {
    var out: [Section] = []
    if hasStatus { out.append(.status) }
    if hasAnswerBody { out.append(.answer) }
    if hasSubjects { out.append(.subjects) }
    if hasQuestion { out.append(.question) }
    if hasCandidates { out.append(.candidates) }
    if hasDamageCalc { out.append(.damageCalc) }
    if hasTeams { out.append(.teams) }
    if hasSuggestions { out.append(.suggestions) }
    if hasReasoning { out.append(.reasoning) }
    if hasCitations { out.append(.citations) }
    if hasInferences { out.append(.inferences) }
    if hasGenerationBasis { out.append(.generationBasis) }
    if hasUncertainty { out.append(.uncertainty) }
    return out
  }

  // MARK: Section rendering

  @ViewBuilder
  private func view(for section: Section) -> some View {
    switch section {
    case .status:
      statusBadge
    case .answer:
      MarkdownText(answer.answerMarkdown)
        .font(Theme.body(.body))
        .foregroundStyle(Theme.textPrimary)
        .frame(maxWidth: .infinity, alignment: .leading)
    case .subjects:
      // Each subject is an openable entity in a structured part of the answer
      // (M-ART-US-1 / M-BR-ART-3): wrap each card in a tap that pushes its full
      // Pokémon profile onto the viewer, reusing the exact SubjectCard rendering.
      VStack(alignment: .leading, spacing: 10) {
        ForEach(Array((answer.subjects ?? []).enumerated()), id: \.offset) { _, subject in
          Button {
            onOpenEntity(.pokemon, subject.name)
          } label: {
            SubjectsView(subjects: [subject])
          }
          .buttonStyle(.plain)
          .accessibilityHint("Opens \(subject.name)'s full profile")
        }
      }
    case .question:
      ClarifyQuestionView(question: answer.question, onSelect: onFollowUp)
    case .candidates:
      if let candidates = answer.candidates {
        CandidatesTableView(candidates: candidates)
      }
    case .damageCalc:
      if let damageCalc = answer.damageCalc {
        DamageCalcView(damageCalc: damageCalc)
      }
    case .teams:
      VStack(alignment: .leading, spacing: 10) {
        TeamBlocksView(
          proposedTeam: answer.proposedTeam,
          proposedTeamWarnings: answer.proposedTeamWarnings ?? [],
          savedTeam: answer.savedTeam,
          onApply: onApplyTeam,
          onOpenSavedTeam: onOpenSavedTeam
        )
        // A proposed team is a structured, openable block (M-ART-US-2): open it as a
        // focused artifact from its INLINE data (no fetch, M-AC-A4.1).
        if let proposed = answer.proposedTeam {
          Button {
            onOpenProposedTeam(proposed, answer.proposedTeamWarnings ?? [])
          } label: {
            Label("Open team in viewer", systemImage: "rectangle.portrait.and.arrow.right")
              .font(Theme.display(.footnote))
          }
          .buttonStyle(.bordered)
          .tint(Theme.accent)
          .accessibilityHint("Opens the proposed team as a full artifact")
        }
      }
    case .suggestions:
      SuggestionsView(
        suggestions: answer.suggestions ?? [],
        status: answer.status,
        onSelect: onFollowUp
      )
    case .reasoning:
      ReasoningSection(markdown: answer.reasoningMarkdown)
    case .citations:
      CitationsView(citations: answer.citations)
    case .inferences:
      InferencesView(inferences: answer.inferences)
    case .generationBasis:
      GenerationBasisView(generationBasis: answer.generationBasis)
    case .uncertainty:
      UncertaintyFlagsView(uncertaintyFlags: answer.uncertaintyFlags)
    }
  }

  // MARK: Status badge (non-`answered` outcomes)

  /// A labeled status chip for non-`answered` outcomes — an icon + word so the
  /// outcome never rests on color alone (M-AC-UI9.3). Mirrors the chip the P6
  /// minimal view carried, now owned by the full card.
  private var statusBadge: some View {
    Label(statusText, systemImage: statusIcon)
      .font(Theme.display(.caption))
      .foregroundStyle(statusColor)
      .labelStyle(.titleAndIcon)
  }

  private var statusText: String {
    switch answer.status {
    case .answered: return "Answered"
    case .clarificationNeeded: return "Needs clarification"
    case .resolutionFailed: return "Couldn't find that"
    case .insufficientData: return "Not enough data"
    }
  }

  private var statusIcon: String {
    switch answer.status {
    case .answered: return "checkmark.seal"
    case .clarificationNeeded: return "questionmark.circle"
    case .resolutionFailed: return "magnifyingglass"
    case .insufficientData: return "exclamationmark.circle"
    }
  }

  private var statusColor: Color {
    switch answer.status {
    case .answered: return Theme.success
    case .clarificationNeeded: return Theme.info
    case .resolutionFailed: return Theme.warning
    case .insufficientData: return Theme.warning
    }
  }

  // MARK: Presence predicates (mirror each subview's own render-if-present guard)

  private var hasStatus: Bool { answer.status != .answered }

  /// The answer prose always renders — it's the required bottom-line of every turn.
  private var hasAnswerBody: Bool { true }

  private var hasSubjects: Bool { !(answer.subjects ?? []).isEmpty }

  private var hasQuestion: Bool { !(answer.question?.options ?? []).isEmpty }

  private var hasCandidates: Bool { !(answer.candidates?.shown ?? []).isEmpty }

  private var hasDamageCalc: Bool { answer.damageCalc != nil }

  private var hasTeams: Bool { answer.proposedTeam != nil || answer.savedTeam != nil }

  private var hasSuggestions: Bool { !Self.nonBlank(answer.suggestions).isEmpty }

  private var hasReasoning: Bool { !Self.trimmed(answer.reasoningMarkdown).isEmpty }

  private var hasCitations: Bool { !answer.citations.isEmpty }

  private var hasInferences: Bool { !answer.inferences.isEmpty }

  /// Mirrors ``GenerationBasisView``: it renders nothing only when the generation
  /// is blank, there is no fallback, and there is no note to explain.
  private var hasGenerationBasis: Bool {
    let basis = answer.generationBasis
    let generation = Self.trimmed(basis.generation)
    let note = Self.trimmed(basis.note ?? "")
    return !generation.isEmpty || basis.fallback || !note.isEmpty
  }

  private var hasUncertainty: Bool { !Self.nonBlank(answer.uncertaintyFlags).isEmpty }

  // MARK: Trim helpers

  private static func trimmed(_ value: String) -> String {
    value.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Non-blank, trimmed entries of an optional string array (matches the trimming
  /// ``SuggestionsView`` / ``UncertaintyFlagsView`` apply before deciding to show).
  private static func nonBlank(_ values: [String]?) -> [String] {
    (values ?? [])
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
  }
}

// MARK: - Reasoning ("why") disclosure

/// The collapsible "Reasoning" section — native mirror of the web `ReasoningBlock`
/// (`reasoning_markdown`), closed by default. Kept file-scoped (one disclosure with
/// its own expansion `@State`) since the orchestrator only needs it here; the rest
/// of the AnswerCard tree has no reasoning leaf of its own.
private struct ReasoningSection: View {
  let markdown: String

  @State private var isExpanded = false

  var body: some View {
    DisclosureGroup(isExpanded: $isExpanded) {
      MarkdownText(markdown)
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textSecondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.top, 8)
    } label: {
      Label("Reasoning", systemImage: "brain")
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.textPrimary)
    }
    .tint(Theme.textSecondary)
    .accessibilityHint("Shows how Oak reached this answer")
  }
}

#if DEBUG
#Preview("Answered — full") {
  ScrollView {
    AnswerCardView(
      answer: OakAnswer(
        status: .answered,
        answerMarkdown:
          "**Garchomp** is the fastest of these Dragons at base **102** Speed.",
        reasoningMarkdown:
          "Resolved Garchomp, read base stats, and compared Speed across the set.",
        citations: [
          Citation(
            source: "PokeAPI",
            detail: "Garchomp base stats (#445)",
            endpointUrl: "https://pokeapi.co/api/v2/pokemon/445"
          )
        ],
        inferences: [
          Inference(
            claim: "Garchomp outspeeds Tyranitar without investment.",
            confidence: .high,
            note: "102 vs 61 base Speed."
          )
        ],
        generationBasis: GenerationBasis(
          generation: "Gen 9 (Scarlet/Violet)",
          fallback: false,
          note: nil
        ),
        subjects: [
          Subject(
            name: "Garchomp",
            dexNumber: 445,
            spriteUrl: "https://example.invalid/garchomp.png",
            types: ["dragon", "ground"],
            isFallback: false,
            sourceGeneration: nil
          )
        ],
        candidates: nil,
        damageCalc: nil,
        suggestions: ["Show its best moveset", "Compare with Dragapult"],
        question: nil,
        uncertaintyFlags: ["Speed assumes a neutral nature with no investment."],
        proposedTeam: nil,
        savedTeam: nil,
        proposedTeamWarnings: nil
      ),
      onFollowUp: { _ in }
    )
    .padding()
  }
}

#Preview("Clarification") {
  ScrollView {
    AnswerCardView(
      answer: OakAnswer(
        status: .clarificationNeeded,
        answerMarkdown: "Which format are you asking about?",
        reasoningMarkdown: "The best spread differs between Singles and Doubles.",
        citations: [],
        inferences: [],
        generationBasis: GenerationBasis(
          generation: "Gen 9 (Scarlet/Violet)",
          fallback: false,
          note: nil
        ),
        subjects: nil,
        candidates: nil,
        damageCalc: nil,
        suggestions: nil,
        question: ClarifyQuestion(options: [
          ClarifyOption(label: "Singles", description: "Smogon 1v1."),
          ClarifyOption(label: "Doubles", description: "VGC 2v2."),
        ]),
        uncertaintyFlags: nil,
        proposedTeam: nil,
        savedTeam: nil,
        proposedTeamWarnings: nil
      ),
      onFollowUp: { _ in }
    )
    .padding()
  }
}
#endif
