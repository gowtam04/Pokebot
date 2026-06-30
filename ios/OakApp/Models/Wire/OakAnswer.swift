import Foundation

/// The single structured answer the agent emits per turn — the field-by-field
/// render target for the chat UI.
///
/// Faithful Swift mirror of `oakAnswerSchema` (and its sub-objects) in
/// `web/src/agent/schemas.ts`. The TypeScript/Zod definition is authoritative; if
/// it changes, this mirror must change (a round-trip decode test guards the drift).
///
/// Wire keys are `snake_case`; Swift properties are `camelCase`. The mapping is
/// declared with **explicit `CodingKeys`** on every type that has a key to rename
/// — there is no global `.convertFromSnakeCase` decoding strategy (payloads across
/// the app mix conventions, so the conversion is opt-in per type). Types whose
/// properties already equal their wire key (e.g. `BaseStats`, `ProposedTeam`) rely
/// on the synthesized coding keys, which produce the exact wire names.
///
/// `Format`, `TeamMember`, and `TeamWarning` live in `Team.swift`; `JSONScalar`
/// lives in `JSONScalar.swift` — referenced here, never redefined (one module).
///
/// In-domain failures are **values, not errors**: a non-`answered` status, empty
/// `subjects`, `resolution_failed` `suggestions`, etc. are normal results rendered
/// in the UI, never thrown.
struct OakAnswer: Codable, Sendable, Equatable {
  /// The outcome of the turn. Drives which optional blocks the UI expects.
  enum Status: String, Codable, Sendable, Equatable {
    case answered
    case clarificationNeeded = "clarification_needed"
    case resolutionFailed = "resolution_failed"
    case insufficientData = "insufficient_data"
  }

  let status: Status
  let answerMarkdown: String
  let reasoningMarkdown: String
  let citations: [Citation]
  let inferences: [Inference]
  let generationBasis: GenerationBasis

  // Optional, render-if-present.
  let subjects: [Subject]?
  let candidates: Candidates?
  let damageCalc: DamageCalc?
  let suggestions: [String]?
  let question: ClarifyQuestion?
  let uncertaintyFlags: [String]?

  // Team-builder fields. `proposedTeam` is model-emitted; `savedTeam` and
  // `proposedTeamWarnings` are server-stamped onto the answer.
  let proposedTeam: ProposedTeam?
  let savedTeam: SavedTeamRef?
  let proposedTeamWarnings: [TeamWarning]?

  enum CodingKeys: String, CodingKey {
    case status
    case answerMarkdown = "answer_markdown"
    case reasoningMarkdown = "reasoning_markdown"
    case citations
    case inferences
    case generationBasis = "generation_basis"
    case subjects
    case candidates
    case damageCalc = "damage_calc"
    case suggestions
    case question
    case uncertaintyFlags = "uncertainty_flags"
    case proposedTeam = "proposed_team"
    case savedTeam = "saved_team"
    case proposedTeamWarnings = "proposed_team_warnings"
  }
}

/// A cited source backing the answer (mirrors `citationSchema`).
struct Citation: Codable, Sendable, Equatable {
  let source: String
  let detail: String
  let endpointUrl: String?

  enum CodingKeys: String, CodingKey {
    case source
    case detail
    case endpointUrl = "endpoint_url"
  }
}

/// A claim the agent deduced rather than read directly (mirrors `inferenceSchema`).
struct Inference: Codable, Sendable, Equatable {
  enum Confidence: String, Codable, Sendable, Equatable {
    case high
    case medium
    case low
  }

  let claim: String
  let confidence: Confidence
  let note: String?
}

/// The generation/format the answer is based on (mirrors `generationBasisSchema`).
struct GenerationBasis: Codable, Sendable, Equatable {
  let generation: String
  let fallback: Bool
  let note: String?
}

/// A primary entity the answer is about, for the header sprite/badges
/// (mirrors `subjectSchema`).
struct Subject: Codable, Sendable, Equatable {
  let name: String
  let dexNumber: Int?
  let spriteUrl: String
  let types: [String]
  let isFallback: Bool
  let sourceGeneration: String?

  enum CodingKeys: String, CodingKey {
    case name
    case dexNumber = "dex_number"
    case spriteUrl = "sprite_url"
    case types
    case isFallback = "is_fallback"
    case sourceGeneration = "source_generation"
  }
}

/// A result set the answer enumerates (mirrors `candidatesSchema`).
struct Candidates: Codable, Sendable, Equatable {
  let totalCount: Int
  let truncated: Bool
  /// Present-or-null on the wire (`z.string().nullable().optional()`); both map to nil.
  let sort: String?
  let shown: [CandidateRow]

  enum CodingKeys: String, CodingKey {
    case totalCount = "total_count"
    case truncated
    case sort
    case shown
  }
}

/// One row in a `candidates` table (mirrors `candidateRowSchema`).
struct CandidateRow: Codable, Sendable, Equatable {
  let name: String
  let dexNumber: Int?
  let spriteUrl: String?
  let types: [String]
  let baseStats: BaseStats?
  /// Free-form scalar map; `CandidateTable` falls back to this when `baseStats` is absent.
  let keyStats: [String: JSONScalar]?
  let ability: String?

  enum CodingKeys: String, CodingKey {
    case name
    case dexNumber = "dex_number"
    case spriteUrl = "sprite_url"
    case types
    case baseStats = "base_stats"
    case keyStats = "key_stats"
    case ability
  }
}

/// The six-stat block, in fixed order — mirrors `baseStatsSchema` in
/// `web/src/agent/schemas.ts` (the source for `candidateRowSchema.base_stats`,
/// `pokedexRowSchema`, and `pokemonProfileSchema`/the entity artifact). Unlike the
/// team `StatSpread` (`statSpreadSchema`, which uses the abbreviated `atk/def/spa`
/// wire keys), `baseStatsSchema` sends the FULL stat names
/// (`attack/defense/special_attack/special_defense/speed`), so the abbreviated
/// Swift properties are mapped with explicit `CodingKeys`.
struct BaseStats: Codable, Sendable, Equatable {
  let hp: Int
  let atk: Int
  let def: Int
  let spa: Int
  let spd: Int
  let spe: Int

  enum CodingKeys: String, CodingKey {
    case hp
    case atk = "attack"
    case def = "defense"
    case spa = "special_attack"
    case spd = "special_defense"
    case spe = "speed"
  }
}

/// A non-authoritative damage estimate (mirrors `damageCalcSchema`).
struct DamageCalc: Codable, Sendable, Equatable {
  let assumptions: [String: JSONScalar]
  let result: [String: JSONScalar]
  /// Always `true` on the wire (`z.literal(true)`); kept a `Bool` for decode tolerance.
  let isEstimate: Bool
  let breakdown: String?

  enum CodingKeys: String, CodingKey {
    case assumptions
    case result
    case isEstimate = "is_estimate"
    case breakdown
  }
}

/// A focused multiple-choice question shown on a `clarification_needed` answer
/// (mirrors `questionSchema`).
struct ClarifyQuestion: Codable, Sendable, Equatable {
  let options: [ClarifyOption]
}

/// One selectable option in a `ClarifyQuestion` (mirrors `questionOptionSchema`).
/// `label` is sent verbatim as the next user message when tapped.
struct ClarifyOption: Codable, Sendable, Equatable {
  let label: String
  let description: String?
}

/// A buildable team the agent proposes for the user to Apply (mirrors
/// `proposedTeamSchema`). `format`/`members` come from `Team.swift`.
struct ProposedTeam: Codable, Sendable, Equatable {
  let name: String
  let format: Format
  let members: [TeamMember]
}

/// A reference to a team the agent saved this turn (mirrors `savedTeamSchema`),
/// server-stamped so the UI can render a "Saved ✓ — open in viewer" card.
struct SavedTeamRef: Codable, Sendable, Equatable {
  let id: String
  let name: String
  let format: Format
}
