import Foundation
import Testing

@testable import OakApp

/// `AnswerCardView` — the field-by-field orchestrator (component-design.md "AnswerCard
/// tree"; chat-experience.md M-AC-1.2/1.4, M-BR-CHAT-5; ui-and-experience.md
/// M-UI-US-1/9). It must render each leaf subview **only when its field is present**
/// (render-if-present) and represent every field the web AnswerCard renders.
///
/// SwiftUI view bodies can't be introspected without a third-party view-inspection
/// package, which ADR-5 forbids. So the orchestration is tested through the card's
/// pure ``AnswerCardView/sections`` list — the single source of truth that `body`
/// renders verbatim (`ForEach(sections)`). A section present ⇒ that subview is
/// invoked; a section absent ⇒ the subview is never constructed, i.e. it renders
/// nothing. Each `Section` case maps 1:1 to a subview, so per-section assertions are
/// the per-subview "field present vs absent" structure tests.
///
/// `@MainActor` because `View` members are main-actor isolated (reading `sections`
/// off a `View` value is main-actor work).
@MainActor
struct AnswerCardViewTests {

  // MARK: Builders

  /// A minimal `OakAnswer`: an `answered` turn with only the always-present answer
  /// body and every optional/structured field empty/absent. Each presence test adds
  /// exactly one field on top of this base.
  private func makeAnswer(
    status: OakAnswer.Status = .answered,
    answerMarkdown: String = "Garchomp is a Dragon/Ground pseudo-legendary.",
    reasoningMarkdown: String = "",
    citations: [Citation] = [],
    inferences: [Inference] = [],
    generationBasis: GenerationBasis = GenerationBasis(generation: "", fallback: false, note: nil),
    subjects: [Subject]? = nil,
    candidates: Candidates? = nil,
    damageCalc: DamageCalc? = nil,
    suggestions: [String]? = nil,
    question: ClarifyQuestion? = nil,
    uncertaintyFlags: [String]? = nil,
    proposedTeam: ProposedTeam? = nil,
    savedTeam: SavedTeamRef? = nil,
    proposedTeamWarnings: [TeamWarning]? = nil
  ) -> OakAnswer {
    OakAnswer(
      status: status,
      answerMarkdown: answerMarkdown,
      reasoningMarkdown: reasoningMarkdown,
      citations: citations,
      inferences: inferences,
      generationBasis: generationBasis,
      subjects: subjects,
      candidates: candidates,
      damageCalc: damageCalc,
      suggestions: suggestions,
      question: question,
      uncertaintyFlags: uncertaintyFlags,
      proposedTeam: proposedTeam,
      savedTeam: savedTeam,
      proposedTeamWarnings: proposedTeamWarnings
    )
  }

  private func sections(_ answer: OakAnswer) -> [AnswerCardView.Section] {
    AnswerCardView(answer: answer).sections
  }

  // Reusable non-empty sub-values.
  private let sampleSubject = Subject(
    name: "Garchomp",
    dexNumber: 445,
    spriteUrl: "https://example.invalid/garchomp.png",
    types: ["dragon", "ground"],
    isFallback: false,
    sourceGeneration: nil
  )
  private let sampleCandidates = Candidates(
    totalCount: 1,
    truncated: false,
    sort: nil,
    shown: [
      CandidateRow(
        name: "Dragapult",
        dexNumber: 887,
        spriteUrl: nil,
        types: ["dragon", "ghost"],
        baseStats: nil,
        keyStats: nil,
        ability: nil
      )
    ]
  )
  private let sampleDamage = DamageCalc(
    assumptions: [:],
    result: ["min_damage": .int(40)],
    isEstimate: true,
    breakdown: nil
  )
  private let sampleQuestion = ClarifyQuestion(options: [
    ClarifyOption(label: "Singles", description: nil)
  ])
  private let sampleProposedTeam = ProposedTeam(
    name: "Sun Offense",
    format: .scarletViolet,
    members: []
  )
  private let sampleSavedTeam = SavedTeamRef(
    id: "team_1",
    name: "Sun Offense",
    format: .scarletViolet
  )

  // MARK: Base — only the always-present answer body renders

  @Test
  func minimalAnswerRendersOnlyTheAnswerBody() {
    #expect(sections(makeAnswer()) == [.answer])
  }

  // MARK: Status badge (non-`answered` outcomes only)

  @Test
  func statusBadgeAbsentForAnsweredPresentOtherwise() {
    #expect(!sections(makeAnswer(status: .answered)).contains(.status))
    #expect(sections(makeAnswer(status: .clarificationNeeded)).contains(.status))
    #expect(sections(makeAnswer(status: .resolutionFailed)).contains(.status))
    #expect(sections(makeAnswer(status: .insufficientData)).contains(.status))
  }

  // MARK: Subjects

  @Test
  func subjectsPresentWhenNonEmptyAbsentOtherwise() {
    #expect(!sections(makeAnswer(subjects: nil)).contains(.subjects))
    #expect(!sections(makeAnswer(subjects: [])).contains(.subjects))
    #expect(sections(makeAnswer(subjects: [sampleSubject])).contains(.subjects))
  }

  // MARK: Clarify question

  @Test
  func questionPresentOnlyWithOptions() {
    #expect(!sections(makeAnswer(question: nil)).contains(.question))
    #expect(!sections(makeAnswer(question: ClarifyQuestion(options: []))).contains(.question))
    #expect(sections(makeAnswer(question: sampleQuestion)).contains(.question))
  }

  // MARK: Candidates

  @Test
  func candidatesPresentOnlyWithShownRows() {
    #expect(!sections(makeAnswer(candidates: nil)).contains(.candidates))
    let empty = Candidates(totalCount: 0, truncated: false, sort: nil, shown: [])
    #expect(!sections(makeAnswer(candidates: empty)).contains(.candidates))
    #expect(sections(makeAnswer(candidates: sampleCandidates)).contains(.candidates))
  }

  // MARK: Damage calc

  @Test
  func damageCalcPresentWhenSet() {
    #expect(!sections(makeAnswer(damageCalc: nil)).contains(.damageCalc))
    #expect(sections(makeAnswer(damageCalc: sampleDamage)).contains(.damageCalc))
  }

  // MARK: Team blocks (proposed and/or saved)

  @Test
  func teamsPresentForProposedOrSaved() {
    #expect(!sections(makeAnswer(proposedTeam: nil, savedTeam: nil)).contains(.teams))
    #expect(sections(makeAnswer(proposedTeam: sampleProposedTeam)).contains(.teams))
    #expect(sections(makeAnswer(savedTeam: sampleSavedTeam)).contains(.teams))
  }

  // MARK: Suggestions (blank-only collapses to nothing)

  @Test
  func suggestionsPresentOnlyWhenNonBlank() {
    #expect(!sections(makeAnswer(suggestions: nil)).contains(.suggestions))
    #expect(!sections(makeAnswer(suggestions: ["", "   "])).contains(.suggestions))
    #expect(sections(makeAnswer(suggestions: ["Gible"])).contains(.suggestions))
  }

  // MARK: Reasoning

  @Test
  func reasoningPresentOnlyWhenNonBlank() {
    #expect(!sections(makeAnswer(reasoningMarkdown: "")).contains(.reasoning))
    #expect(!sections(makeAnswer(reasoningMarkdown: "   \n ")).contains(.reasoning))
    #expect(sections(makeAnswer(reasoningMarkdown: "Compared Speed.")).contains(.reasoning))
  }

  // MARK: Citations

  @Test
  func citationsPresentWhenNonEmpty() {
    #expect(!sections(makeAnswer(citations: [])).contains(.citations))
    let citation = Citation(source: "PokeAPI", detail: "Base stats", endpointUrl: nil)
    #expect(sections(makeAnswer(citations: [citation])).contains(.citations))
  }

  // MARK: Inferences

  @Test
  func inferencesPresentWhenNonEmpty() {
    #expect(!sections(makeAnswer(inferences: [])).contains(.inferences))
    let inference = Inference(claim: "Outspeeds Tyranitar.", confidence: .high, note: nil)
    #expect(sections(makeAnswer(inferences: [inference])).contains(.inferences))
  }

  // MARK: Generation basis

  @Test
  func generationBasisPresentWhenGenerationFallbackOrNoteIsSet() {
    // Empty generation, no fallback, no note → renders nothing.
    let empty = GenerationBasis(generation: "  ", fallback: false, note: "  ")
    #expect(!sections(makeAnswer(generationBasis: empty)).contains(.generationBasis))

    let named = GenerationBasis(generation: "Gen 9 (Scarlet/Violet)", fallback: false, note: nil)
    #expect(sections(makeAnswer(generationBasis: named)).contains(.generationBasis))

    let fallback = GenerationBasis(generation: "", fallback: true, note: nil)
    #expect(sections(makeAnswer(generationBasis: fallback)).contains(.generationBasis))

    let noted = GenerationBasis(generation: "", fallback: false, note: "Pre-Gen-9 data.")
    #expect(sections(makeAnswer(generationBasis: noted)).contains(.generationBasis))
  }

  // MARK: Uncertainty flags (blank-only collapses to nothing)

  @Test
  func uncertaintyPresentOnlyWhenNonBlank() {
    #expect(!sections(makeAnswer(uncertaintyFlags: nil)).contains(.uncertainty))
    #expect(!sections(makeAnswer(uncertaintyFlags: ["", " "])).contains(.uncertainty))
    #expect(sections(makeAnswer(uncertaintyFlags: ["Estimate only."])).contains(.uncertainty))
  }

  // MARK: Full answer — every block, in reading order, composes without crashing

  @Test
  func everyFieldPresentComposesInReadingOrder() {
    let answer = makeAnswer(
      status: .clarificationNeeded,
      reasoningMarkdown: "Compared Speed across the set.",
      citations: [Citation(source: "PokeAPI", detail: "Base stats", endpointUrl: nil)],
      inferences: [Inference(claim: "Outspeeds Tyranitar.", confidence: .high, note: nil)],
      generationBasis: GenerationBasis(generation: "Gen 9 (Scarlet/Violet)", fallback: false, note: nil),
      subjects: [sampleSubject],
      candidates: sampleCandidates,
      damageCalc: sampleDamage,
      suggestions: ["Show its best moveset"],
      question: sampleQuestion,
      uncertaintyFlags: ["Speed assumes a neutral nature."],
      proposedTeam: sampleProposedTeam,
      savedTeam: sampleSavedTeam,
      proposedTeamWarnings: [
        TeamWarning(code: .incomplete, message: "Partial team.", slot: nil, field: nil)
      ]
    )

    #expect(
      sections(answer) == [
        .status,
        .answer,
        .subjects,
        .question,
        .candidates,
        .damageCalc,
        .teams,
        .suggestions,
        .reasoning,
        .citations,
        .inferences,
        .generationBasis,
        .uncertainty,
      ]
    )
  }

  // MARK: Over the committed status fixtures (contract-real payloads)

  @Test
  func answeredFullFixtureFansOutEveryBlock() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_answered_full.json")
    // `answered` ⇒ no status badge; every other block is populated in the fixture.
    #expect(
      sections(answer) == [
        .answer,
        .subjects,
        .question,
        .candidates,
        .damageCalc,
        .teams,
        .suggestions,
        .reasoning,
        .citations,
        .inferences,
        .generationBasis,
        .uncertainty,
      ]
    )
  }

  @Test
  func clarificationFixtureShowsStatusAnswerQuestionReasoningBasis() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_clarification.json")
    #expect(
      sections(answer) == [.status, .answer, .question, .reasoning, .generationBasis]
    )
  }

  @Test
  func resolutionFailedFixtureShowsStatusAnswerSuggestionsReasoningBasis() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_resolution_failed.json")
    #expect(
      sections(answer) == [.status, .answer, .suggestions, .reasoning, .generationBasis]
    )
  }

  @Test
  func insufficientDataFixtureShowsCitationsBasisAndUncertainty() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_insufficient_data.json")
    #expect(
      sections(answer) == [.status, .answer, .reasoning, .citations, .generationBasis, .uncertainty]
    )
  }

  // MARK: In-domain failures render as answers (M-AC-1.3) — the answer body is
  // always present even for non-`answered` statuses.

  @Test
  func nonAnsweredStatusesStillRenderTheAnswerBody() {
    for status in [
      OakAnswer.Status.clarificationNeeded,
      .resolutionFailed,
      .insufficientData,
    ] {
      let blocks = sections(makeAnswer(status: status))
      #expect(blocks.contains(.answer))
      #expect(blocks.first == .status)  // status badge leads a non-answered card
    }
  }
}
