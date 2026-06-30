/// Team-builder wire DTOs — faithful Swift mirrors of the backend's team model.
///
/// Authoritative TS sources (the TS wins on any disagreement with the docs):
///   - `web/src/data/teams/team-schema.ts` — `statSpreadSchema`, `teamMemberSchema`,
///     `warningCodeSchema`, `teamWarningSchema`.
///   - `web/src/data/formats.ts` — the `Format` discriminator (`"scarlet-violet" | "champions"`).
///   - `web/src/server/teams/validate-team.ts` + `web/src/app/api/teams/route.ts`
///     — the validation result is a FLAT `TeamWarning[]` (the route returns
///     `{ team, validation }`, `validation: TeamWarning[]`).
///
/// Pure value types, no app-specific imports (the would-be shared package if an
/// Android client ever happens). Wire is `snake_case`; Swift is `camelCase`,
/// mapped with explicit per-type `CodingKeys` only where they differ — never a
/// global `.convertFromSnakeCase` (payloads mix conventions).

/// Data-scope format — the discriminator that scopes the index to a game
/// (`formats.ts`). `scarletViolet` is standard mode; `champions` is the Pokémon
/// Champions regulation scope.
enum Format: String, Codable, Sendable, CaseIterable {
  case scarletViolet = "scarlet-violet"
  case champions
}

/// One EV or IV spread. Raw `0..255` per stat on the wire (Showdown permits the
/// full byte range on input); legality (≤252 per EV, ≤508 total, IV `0..31`) is
/// a warn-only concern handled server-side, never enforced by this DTO. All keys
/// match the wire 1:1, so no `CodingKeys` are needed.
struct StatSpread: Codable, Sendable, Equatable {
  let hp: Int
  let atk: Int
  let def: Int
  let spa: Int
  let spd: Int
  let spe: Int
}

/// One team member (set). Slugs are stored, not display names; `nil` means
/// "empty / not set". Mirrors `teamMemberSchema`.
///
/// Wire-fidelity nuance (why the custom `encode(to:)`): `species`, `ability`,
/// `item`, `nature` and `tera_type` are `.nullable()` in Zod — the KEY is
/// required and the value may be `null` (the server always emits e.g.
/// `"item": null`). The cosmetic `nickname`/`gender`/`shiny` are `.optional()`
/// — the key may be ABSENT. Swift's synthesized `encode(to:)` would omit every
/// nil, which would drop the required nullable keys and fail the server's
/// `.strict()` parse. So we encode the nullable-required fields explicitly (as
/// `null` when nil) and `encodeIfPresent` only the truly-optional cosmetics.
/// Decoding is the synthesized one (`decodeIfPresent` tolerates both null and
/// absent), so only `encode(to:)` is hand-written.
struct TeamMember: Codable, Sendable, Equatable {
  /// Pokémon slug; `nil` = empty slot.
  let species: String?
  /// Ability slug; `nil` = not set.
  let ability: String?
  /// Held-item slug; `nil` = none.
  let item: String?
  /// Move slugs; may hold fewer than 4 (a partial team is valid).
  let moves: [String]
  /// Nature slug; `nil` = not set.
  let nature: String?
  /// EV spread (raw `0..255` per stat).
  let evs: StatSpread
  /// IV spread (`0..31` expected; warned, not blocked).
  let ivs: StatSpread
  /// Tera-type slug (wire `tera_type`); `nil` = not set.
  let teraType: String?
  /// Level (`1..100`; default 50 in both formats).
  let level: Int
  /// Cosmetic — round-tripped on import/export, not competitively significant.
  let nickname: String?
  /// Cosmetic gender flag.
  let gender: Gender?
  /// Cosmetic shiny flag.
  let shiny: Bool?

  /// Cosmetic gender (`z.enum(["M", "F", "N"])`).
  enum Gender: String, Codable, Sendable, Equatable {
    case male = "M"
    case female = "F"
    case neutral = "N"
  }

  enum CodingKeys: String, CodingKey {
    case species
    case ability
    case item
    case moves
    case nature
    case evs
    case ivs
    case teraType = "tera_type"
    case level
    case nickname
    case gender
    case shiny
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    // `.nullable()` required keys — always present, explicit `null` when nil.
    try container.encode(species, forKey: .species)
    try container.encode(ability, forKey: .ability)
    try container.encode(item, forKey: .item)
    try container.encode(moves, forKey: .moves)
    try container.encode(nature, forKey: .nature)
    try container.encode(evs, forKey: .evs)
    try container.encode(ivs, forKey: .ivs)
    try container.encode(teraType, forKey: .teraType)
    try container.encode(level, forKey: .level)
    // `.optional()` cosmetics — omitted when nil.
    try container.encodeIfPresent(nickname, forKey: .nickname)
    try container.encodeIfPresent(gender, forKey: .gender)
    try container.encodeIfPresent(shiny, forKey: .shiny)
  }
}

/// One advisory team warning (`teamWarningSchema`). Advisory-only: warnings are
/// rendered, never thrown (in-domain failures are values). `slot` absent ⇒
/// team-level (e.g. species/item clauses). All keys match the wire 1:1.
struct TeamWarning: Codable, Sendable, Equatable {
  /// The validity/legality rules `validateTeam` can flag (`warningCodeSchema`).
  enum Code: String, Codable, Sendable, Equatable {
    case incomplete
    case evTotalExceeded = "ev_total_exceeded"
    case evStatExceeded = "ev_stat_exceeded"
    case ivOutOfRange = "iv_out_of_range"
    case speciesIllegal = "species_illegal"
    case abilityNotForSpecies = "ability_not_for_species"
    case itemIllegal = "item_illegal"
    case moveNotInLearnset = "move_not_in_learnset"
    case duplicateSpecies = "duplicate_species"
    case duplicateItem = "duplicate_item"
  }

  let code: Code
  let message: String
  /// `0..5`; absent ⇒ team-level.
  let slot: Int?
  /// e.g. `"evs.atk"`, `"moves[2]"`, `"ability"`.
  let field: String?
}

/// The advisory result of `validateTeam`, returned alongside a created/updated
/// team. The server shape is a FLAT `TeamWarning[]` (the route's `validation`
/// field), so this wrapper encodes/decodes the bare array directly via a
/// single-value container — making it usable as the decode target for
/// `validation` while still exposing a named `warnings` property.
struct TeamValidationResult: Codable, Sendable, Equatable {
  let warnings: [TeamWarning]

  init(warnings: [TeamWarning]) {
    self.warnings = warnings
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    self.warnings = try container.decode([TeamWarning].self)
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(warnings)
  }
}
