import Foundation

/// The `GET /api/entity` response — a faithful mirror of `EntityArtifactResponse`
/// in `web/src/lib/entity-artifact.ts` (the ONE definition the backend and every
/// client build to).
///
/// A discriminated union on `status`:
/// ```ts
/// export const entityArtifactResponseSchema = z.union([
///   entityArtifactOkSchema,            // status: "ok"
///   entityArtifactNotFoundSchema,      // status: "not_found"
///   entityArtifactUnavailableSchema,   // status: "unavailable"
/// ]);
/// ```
/// The `ok` arm is further discriminated on entity `kind`
/// (`pokemon`/`move`/`ability`/`item`/`type`), each carrying a kind-specific
/// `data` payload. The per-kind `data` shapes are composed from the entity
/// schemas in `web/src/agent/schemas.ts` with the `found` discriminant dropped
/// (the envelope's `status` carries it).
///
/// Received-only (`Decodable`); `not_found`/`unavailable` are honest in-domain
/// misses rendered in the viewer, never thrown (ArtifactService returns `nil`,
/// not an error).
enum EntityArtifact: Decodable, Sendable {
  case ok(EntityArtifactOk)
  case notFound(EntityArtifactNotFound)
  case unavailable(EntityArtifactUnavailable)

  private enum StatusKey: String, CodingKey {
    case status
  }

  /// The `status` literal that selects the envelope arm.
  private enum Status: String, Decodable {
    case ok
    case notFound = "not_found"
    case unavailable
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: StatusKey.self)
    switch try container.decode(Status.self, forKey: .status) {
    case .ok:
      self = .ok(try EntityArtifactOk(from: decoder))
    case .notFound:
      self = .notFound(try EntityArtifactNotFound(from: decoder))
    case .unavailable:
      self = .unavailable(try EntityArtifactUnavailable(from: decoder))
    }
  }
}

/// The five entity kinds an artifact can describe — mirrors `entityKindSchema`
/// (`ENTITY_KINDS`) in `web/src/agent/schemas.ts`. Serves as the `ok` arm's
/// discriminant and as the `kind` on the `not_found`/`unavailable` misses, and is
/// the input kind for `ArtifactService.entity(kind:q:format:)`.
enum EntityKind: String, Codable, Sendable, CaseIterable {
  case pokemon
  case move
  case ability
  case item
  case type
}

// ---------------------------------------------------------------------------
// ok envelope (grounding chrome + kind-specific data)
// ---------------------------------------------------------------------------

/// The `ok` envelope — `okBaseSchema` (grounding chrome) plus a `kind`-specific
/// `data` payload (`entityArtifactOkSchema`):
/// ```ts
/// { status: "ok", format, resolved: { slug, display_name }, generation,
///   is_fallback, fallback_note?, citations: Citation[], kind, data }
/// ```
struct EntityArtifactOk: Decodable, Sendable {
  let kind: EntityKind
  let format: Format
  let resolved: ResolvedEntity
  let generation: String
  let isFallback: Bool
  let fallbackNote: String?
  let citations: [Citation]
  let data: EntityData

  private enum CodingKeys: String, CodingKey {
    case kind
    case format
    case resolved
    case generation
    case isFallback = "is_fallback"
    case fallbackNote = "fallback_note"
    case citations
    case data
  }

  init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try container.decode(EntityKind.self, forKey: .kind)
    self.kind = kind
    self.format = try container.decode(Format.self, forKey: .format)
    self.resolved = try container.decode(ResolvedEntity.self, forKey: .resolved)
    self.generation = try container.decode(String.self, forKey: .generation)
    self.isFallback = try container.decode(Bool.self, forKey: .isFallback)
    self.fallbackNote = try container.decodeIfPresent(String.self, forKey: .fallbackNote)
    self.citations = try container.decode([Citation].self, forKey: .citations)
    switch kind {
    case .pokemon:
      self.data = .pokemon(try container.decode(PokemonArtifactData.self, forKey: .data))
    case .move:
      self.data = .move(try container.decode(MoveArtifactData.self, forKey: .data))
    case .ability:
      self.data = .ability(try container.decode(AbilityArtifactData.self, forKey: .data))
    case .item:
      self.data = .item(try container.decode(ItemArtifactData.self, forKey: .data))
    case .type:
      self.data = .type(try container.decode(TypeArtifactData.self, forKey: .data))
    }
  }
}

/// The resolved entity's canonical slug + display name (`okBaseSchema.resolved`).
struct ResolvedEntity: Decodable, Sendable {
  let slug: String
  let displayName: String

  private enum CodingKeys: String, CodingKey {
    case slug
    case displayName = "display_name"
  }
}

/// The kind-specific payload of an `ok` artifact, selected by `EntityArtifactOk.kind`.
enum EntityData: Sendable {
  case pokemon(PokemonArtifactData)
  case move(MoveArtifactData)
  case ability(AbilityArtifactData)
  case item(ItemArtifactData)
  case type(TypeArtifactData)
}

// ---------------------------------------------------------------------------
// Per-kind data shapes (pokemonProfileSchema/moveDetailSchema/… minus `found`)
// ---------------------------------------------------------------------------

/// `data` for a Pokémon artifact — `pokemonArtifactDataSchema`: the
/// `pokemonProfileSchema` fields (minus `found`) plus the combined defensive
/// `matchups` and the grouped `movepool`.
struct PokemonArtifactData: Decodable, Sendable {
  let displayName: String
  let nationalDexNumber: Int
  let types: [String]
  let abilities: Abilities
  let baseStats: BaseStats
  let baseStatTotal: Int
  let spriteUrl: String
  let artworkUrl: String
  let forms: [String]
  let isGen9Native: Bool
  /// `z.string().nullish()` — absent or null.
  let sourceGeneration: String?
  /// Combined defensive matchups for the species' actual type(s).
  let matchups: DefensiveProfile
  /// Full movepool for the active format, grouped by learn method.
  let movepool: [MovepoolGroup]

  private enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case nationalDexNumber = "national_dex_number"
    case types
    case abilities
    case baseStats = "base_stats"
    case baseStatTotal = "base_stat_total"
    case spriteUrl = "sprite_url"
    case artworkUrl = "artwork_url"
    case forms
    case isGen9Native = "is_gen9_native"
    case sourceGeneration = "source_generation"
    case matchups
    case movepool
  }
}

/// A species' ability slots — `abilitiesSchema` in `schemas.ts`. `slot1` is
/// always present; `slot2`/`hidden` may be absent or null (`z.string().nullish()`).
struct Abilities: Decodable, Sendable {
  let slot1: String
  let slot2: String?
  let hidden: String?
}

/// `data` for a move artifact — `moveDetailSchema` (minus `found`).
struct MoveArtifactData: Decodable, Sendable {
  let displayName: String
  let type: String
  let damageClass: DamageClass
  /// `z.number().int().nullable()` — present, possibly null.
  let power: Int?
  let accuracy: Int?
  let pp: Int?
  let priority: Int
  let target: String
  /// `z.boolean().optional()`.
  let hitsAllies: Bool?
  /// `z.number().nullable().optional()` — a non-integer multiplier.
  let spreadModifierDoubles: Double?
  let effectShort: String
  let effectFull: String
  /// `z.number().int().optional()` — only when the caller requested it.
  let gen9LearnerCount: Int?

  private enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case type
    case damageClass = "damage_class"
    case power
    case accuracy
    case pp
    case priority
    case target
    case hitsAllies = "hits_allies"
    case spreadModifierDoubles = "spread_modifier_doubles"
    case effectShort = "effect_short"
    case effectFull = "effect_full"
    case gen9LearnerCount = "gen9_learner_count"
  }
}

/// A move's damage class — `moveDetailSchema.damage_class`.
enum DamageClass: String, Decodable, Sendable {
  case physical
  case special
  case status
}

/// `data` for an ability artifact — `abilityArtifactDataSchema`: the
/// `abilityDetailSchema` fields (minus `found`) plus `learned_by`.
struct AbilityArtifactData: Decodable, Sendable {
  let displayName: String
  let effectShort: String
  let effectFull: String
  /// Species that have this ability.
  let learnedBy: [AbilityHolder]

  private enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case effectShort = "effect_short"
    case effectFull = "effect_full"
    case learnedBy = "learned_by"
  }
}

/// One species that has a given ability — `abilityHolderSchema`.
struct AbilityHolder: Decodable, Sendable {
  let slug: String
  let displayName: String

  private enum CodingKeys: String, CodingKey {
    case slug
    case displayName = "display_name"
  }
}

/// `data` for an item artifact — `itemArtifactDataSchema` (= `itemDetailSchema`
/// minus `found`).
struct ItemArtifactData: Decodable, Sendable {
  let displayName: String
  let effectShort: String
  let effectFull: String
  /// `z.array(...).optional()` — wild Pokémon known to hold this item.
  let heldByWild: [WildItemHolder]?

  private enum CodingKeys: String, CodingKey {
    case displayName = "display_name"
    case effectShort = "effect_short"
    case effectFull = "effect_full"
    case heldByWild = "held_by_wild"
  }
}

/// A wild Pokémon that may hold an item, with its rarity — `held_by_wild` element.
struct WildItemHolder: Decodable, Sendable {
  let pokemon: String
  /// `z.number()` — a percentage, not necessarily an integer.
  let rarityPercent: Double

  private enum CodingKeys: String, CodingKey {
    case pokemon
    case rarityPercent = "rarity_percent"
  }
}

/// `data` for a type artifact — `typeArtifactDataSchema` (= `typeMatchupsDetailSchema`
/// minus `found`).
struct TypeArtifactData: Decodable, Sendable {
  let types: [String]
  /// Present for a single-type request; omitted for a combined defensive lookup.
  let offensive: OffensiveProfile?
  let defensive: DefensiveProfile
}

/// A type's offensive profile — `typeMatchupsDetailSchema.offensive`.
struct OffensiveProfile: Decodable, Sendable {
  let superEffectiveAgainst: [String]
  let notVeryEffectiveAgainst: [String]
  let noEffectAgainst: [String]

  private enum CodingKeys: String, CodingKey {
    case superEffectiveAgainst = "super_effective_against"
    case notVeryEffectiveAgainst = "not_very_effective_against"
    case noEffectAgainst = "no_effect_against"
  }
}

/// A combined (or single-type) defensive profile — `defensiveProfileSchema`,
/// reused for a Pokémon's matchup grid. `quad_weak_to`/`quad_resists` are optional
/// strict subsets of `weak_to`/`resists` (x4 / x0.25), filled only by the artifact
/// assembler.
struct DefensiveProfile: Decodable, Sendable {
  let weakTo: [String]
  let resists: [String]
  let immuneTo: [String]
  let quadWeakTo: [String]?
  let quadResists: [String]?

  private enum CodingKeys: String, CodingKey {
    case weakTo = "weak_to"
    case resists
    case immuneTo = "immune_to"
    case quadWeakTo = "quad_weak_to"
    case quadResists = "quad_resists"
  }
}

/// One move in a Pokémon's movepool — `movepoolMoveSchema`, clickable with its
/// type badge.
struct MovepoolMove: Decodable, Sendable {
  let slug: String
  let displayName: String
  let type: String

  private enum CodingKeys: String, CodingKey {
    case slug
    case displayName = "display_name"
    case type
  }
}

/// Movepool grouped by learn method (level-up / machine / tutor / egg) —
/// `movepoolGroupSchema`.
struct MovepoolGroup: Decodable, Sendable {
  let method: String
  let moves: [MovepoolMove]
}

// ---------------------------------------------------------------------------
// Miss envelopes (not_found | unavailable)
// ---------------------------------------------------------------------------

/// Resolution miss — `entityArtifactNotFoundSchema`. The entity could not be
/// resolved; `suggestions` are close names to offer.
struct EntityArtifactNotFound: Decodable, Sendable {
  let kind: EntityKind
  let format: Format
  let query: String
  let suggestions: [String]
}

/// Index unavailable — `entityArtifactUnavailableSchema`. Honest failure; never
/// fabricated data.
struct EntityArtifactUnavailable: Decodable, Sendable {
  let kind: EntityKind
  let format: Format
}
