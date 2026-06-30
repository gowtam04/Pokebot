import Foundation
import Testing

@testable import OakApp

/// Contract-drift guard (testing-strategy.md "DTO decoding/round-trip", Phase 3).
///
/// Every committed wire fixture is decoded into its Swift DTO, and the `OakAnswer`
/// fixtures additionally round-trip (decode → encode → decode) with NO data loss.
/// DTOs are built FROM the fixtures (never inline literals), so if a `web/` Zod
/// contract changes and a fixture is regenerated, decoding fails loudly here.
///
/// The fixtures themselves are guaranteed contract-valid: each was parsed through
/// the repo's own Zod schemas (`oakAnswerSchema`, `entityArtifactResponseSchema`,
/// `teamMembersSchema`, …) before being committed, since no live `/api/chat`
/// fixtures exist to capture.
struct FixtureDecodingTests {

  // MARK: decode-every-JSON-fixture

  /// Decodes each JSON fixture into the DTO it mirrors. A failure to decode any
  /// fixture fails this case for that argument — the "none rot" guarantee.
  @Test(arguments: jsonFixtures)
  func decodesEveryJSONFixture(_ name: String) throws {
    switch name {
    case "oakanswer_answered_full.json",
      "oakanswer_clarification.json",
      "oakanswer_resolution_failed.json",
      "oakanswer_insufficient_data.json":
      _ = try Fixtures.decode(OakAnswer.self, from: name)
    case "conversations_list.json":
      _ = try Fixtures.decode(ConversationsListEnvelope.self, from: name)
    case "conversation_detail.json":
      _ = try Fixtures.decode(ConversationDetail.self, from: name)
    case "team.json":
      _ = try Fixtures.decode(TeamEnvelope.self, from: name)
    case "teams_list.json":
      _ = try Fixtures.decode(TeamsListEnvelope.self, from: name)
    case "entity_pokemon.json",
      "entity_move.json",
      "entity_ability.json",
      "entity_item.json",
      "entity_type.json",
      "entity_not_found.json",
      "entity_unavailable.json":
      _ = try Fixtures.decode(EntityArtifact.self, from: name)
    case "auth_verify.json":
      _ = try Fixtures.decode(AuthVerifyResponse.self, from: name)
    case "me.json", "me_guest.json":
      _ = try Fixtures.decode(MeResponse.self, from: name)
    case "api_error.json":
      _ = try Fixtures.decode(APIErrorBody.self, from: name)
    default:
      Issue.record("Unhandled JSON fixture \"\(name)\" — add a decode arm.")
    }
  }

  // MARK: OakAnswer — no-data-loss round-trip

  /// decode → encode → decode → equality. Because `OakAnswer` (and every
  /// sub-struct, including the custom `TeamMember.encode` and the `JSONScalar`
  /// maps) is `Equatable`, an exact re-decode equality proves nothing was dropped
  /// or coerced across a full Codable round-trip.
  @Test(arguments: oakAnswerFixtures)
  func oakAnswerRoundTripsWithoutLoss(_ name: String) throws {
    let original = try Fixtures.decode(OakAnswer.self, from: name)
    let reencoded = try JSONEncoder().encode(original)
    let roundTripped = try JSONDecoder().decode(OakAnswer.self, from: reencoded)
    #expect(roundTripped == original)
  }

  // MARK: focused field-fidelity spot-checks

  /// The "all optional fields populated" answer decodes every render-if-present
  /// block, the team-builder fields, and the heterogeneous scalar maps.
  @Test
  func answeredFullDecodesAllOptionalFields() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_answered_full.json")

    #expect(answer.status == .answered)
    #expect(answer.citations.count == 2)
    #expect(answer.citations.first?.endpointUrl != nil)
    #expect(answer.inferences.first?.confidence == .high)
    #expect(answer.generationBasis.fallback == false)

    let subject = try #require(answer.subjects?.first)
    #expect(subject.name == "Garchomp")
    #expect(subject.dexNumber == 445)
    #expect(subject.types == ["dragon", "ground"])

    let candidates = try #require(answer.candidates)
    #expect(candidates.totalCount == 2)
    #expect(candidates.sort == "speed desc")
    #expect(candidates.shown.count == 2)

    // Row 0 carries the full six-stat block (full wire stat names → abbreviated
    // Swift props) plus a heterogeneous key_stats scalar map.
    let dragapult = candidates.shown[0]
    #expect(dragapult.baseStats?.spe == 142)
    #expect(dragapult.keyStats?["speed"] == .int(142))
    #expect(dragapult.keyStats?["role"] == .string("fast attacker"))
    #expect(dragapult.keyStats?["fully_invested"] == .bool(true))
    #expect(dragapult.keyStats?["speed_tier"] == .double(9.5))
    #expect(dragapult.keyStats?["notes"] == .null)

    // Row 1 omits base_stats → CandidateTable falls back to key_stats.
    let flutterMane = candidates.shown[1]
    #expect(flutterMane.baseStats == nil)
    #expect(flutterMane.keyStats?["special_attack"] == .int(135))

    let damage = try #require(answer.damageCalc)
    #expect(damage.isEstimate == true)
    #expect(damage.assumptions["stab"] == .bool(true))
    #expect(damage.result["min_damage"] == .int(142))

    #expect(answer.suggestions?.count == 2)
    #expect(answer.question?.options.count == 2)
    #expect(answer.uncertaintyFlags?.isEmpty == false)

    let team = try #require(answer.proposedTeam)
    #expect(team.format == .scarletViolet)
    #expect(team.members.count == 2)
    let chomp = team.members[0]
    #expect(chomp.species == "garchomp")
    #expect(chomp.moves.count == 4)
    #expect(chomp.evs.spe == 252)
    #expect(chomp.teraType == "steel")
    #expect(chomp.gender == .male)
    // Slot 1 has explicit nulls for the nullable-required fields.
    #expect(team.members[1].item == nil)
    #expect(team.members[1].nature == nil)
    #expect(team.members[1].teraType == nil)
    #expect(team.members[1].nickname == nil)

    let saved = try #require(answer.savedTeam)
    #expect(saved.id == "team_abc123")
    #expect(saved.format == .scarletViolet)

    let warnings = try #require(answer.proposedTeamWarnings)
    #expect(warnings.count == 2)
    #expect(warnings[0].code == .incomplete)
    #expect(warnings[0].slot == nil)
    #expect(warnings[1].code == .abilityNotForSpecies)
    #expect(warnings[1].slot == 1)
    #expect(warnings[1].field == "ability")
  }

  /// The clarification answer carries a 2–4 option question (one option without
  /// a description) and omits the answered-only blocks.
  @Test
  func clarificationDecodesQuestion() throws {
    let answer = try Fixtures.decode(OakAnswer.self, from: "oakanswer_clarification.json")
    #expect(answer.status == .clarificationNeeded)
    let options = try #require(answer.question?.options)
    #expect(options.count == 3)
    #expect(options[0].description != nil)
    #expect(options[2].description == nil)
    #expect(answer.subjects == nil)
    #expect(answer.candidates == nil)
  }

  /// `ConversationDetail` rehydrates a mixed user/assistant turn list; the assistant
  /// turn carries a full `OakAnswer`.
  @Test
  func conversationDetailDecodesTurns() throws {
    let detail = try Fixtures.decode(ConversationDetail.self, from: "conversation_detail.json")
    #expect(detail.format == .scarletViolet)
    #expect(detail.turns.count == 2)

    guard case let .user(id, content) = detail.turns[0] else {
      Issue.record("turn 0 should be a user turn")
      return
    }
    #expect(id == "msg_1")
    #expect(content.isEmpty == false)

    guard case let .assistant(assistantId, answer) = detail.turns[1] else {
      Issue.record("turn 1 should be an assistant turn")
      return
    }
    #expect(assistantId == "msg_2")
    #expect(answer.status == .answered)
    #expect(answer.subjects?.first?.name == "Dragapult")
  }

  /// The `{ team, validation }` envelope decodes the full members and the flat
  /// `TeamWarning[]` validation (single-value container).
  @Test
  func teamEnvelopeDecodesMembersAndWarnings() throws {
    let env = try Fixtures.decode(TeamEnvelope.self, from: "team.json")
    #expect(env.team.id == "team_abc123")
    #expect(env.team.format == .scarletViolet)
    #expect(env.team.members.count == 2)
    #expect(env.team.members[0].species == "garchomp")
    #expect(env.team.members[0].evs.atk == 252)
    #expect(env.team.createdAt == 1_719_000_000_000)
    #expect(env.validation.warnings.count == 2)
    #expect(env.validation.warnings[1].code == .moveNotInLearnset)
    #expect(env.validation.warnings[1].field == "moves[2]")
  }

  /// The teams list decodes into full `Team` rows (one populated, one empty).
  @Test
  func teamsListDecodes() throws {
    let env = try Fixtures.decode(TeamsListEnvelope.self, from: "teams_list.json")
    #expect(env.teams.count == 2)
    #expect(env.teams[0].members.count == 1)
    #expect(env.teams[1].format == .champions)
    #expect(env.teams[1].members.isEmpty)
  }

  /// The conversations list decodes summaries (camelCase `updatedAt`, no
  /// `created_at`).
  @Test
  func conversationsListDecodes() throws {
    let env = try Fixtures.decode(ConversationsListEnvelope.self, from: "conversations_list.json")
    #expect(env.conversations.count == 2)
    #expect(env.conversations[0].pinned == true)
    #expect(env.conversations[0].updatedAt == 1_719_600_000_000)
    #expect(env.conversations[1].format == .champions)
  }

  /// The pokemon artifact decodes to the `.ok` arm, kind `pokemon`, with the
  /// pokemon-only `matchups` (incl. quad subsets) and grouped `movepool`.
  @Test
  func entityPokemonDecodesAsOkPokemon() throws {
    let artifact = try Fixtures.decode(EntityArtifact.self, from: "entity_pokemon.json")
    guard case let .ok(ok) = artifact else {
      Issue.record("expected an ok artifact")
      return
    }
    #expect(ok.kind == .pokemon)
    #expect(ok.format == .scarletViolet)
    #expect(ok.resolved.displayName == "Garchomp")
    #expect(ok.citations.isEmpty == false)
    guard case let .pokemon(data) = ok.data else {
      Issue.record("expected pokemon data")
      return
    }
    #expect(data.nationalDexNumber == 445)
    #expect(data.baseStats.spe == 102)
    #expect(data.abilities.slot1 == "sand-veil")
    #expect(data.abilities.hidden == "rough-skin")
    #expect(data.matchups.quadWeakTo == ["ice"])
    #expect(data.movepool.count == 2)
    #expect(data.movepool[0].moves.first?.displayName == "Dragon Claw")
  }

  /// The remaining ok arms (move/ability/item/type) each decode their distinct
  /// kind-specific `data`.
  @Test
  func entityOkArmsDecodeTheirData() throws {
    if case let .ok(move) = try Fixtures.decode(EntityArtifact.self, from: "entity_move.json"),
      case let .move(data) = move.data
    {
      #expect(move.format == .champions)
      #expect(data.damageClass == .physical)
      #expect(data.power == 100)
      #expect(data.hitsAllies == nil)
    } else {
      Issue.record("entity_move should decode to ok/move")
    }

    if case let .ok(ability) = try Fixtures.decode(EntityArtifact.self, from: "entity_ability.json"),
      case let .ability(data) = ability.data
    {
      #expect(data.learnedBy.count == 2)
      #expect(data.learnedBy.first?.displayName == "Garchomp")
    } else {
      Issue.record("entity_ability should decode to ok/ability")
    }

    if case let .ok(item) = try Fixtures.decode(EntityArtifact.self, from: "entity_item.json"),
      case let .item(data) = item.data
    {
      #expect(item.isFallback == true)
      #expect(item.fallbackNote != nil)
      #expect(data.heldByWild?.first?.rarityPercent == 50)
    } else {
      Issue.record("entity_item should decode to ok/item")
    }

    if case let .ok(type) = try Fixtures.decode(EntityArtifact.self, from: "entity_type.json"),
      case let .type(data) = type.data
    {
      #expect(data.offensive?.superEffectiveAgainst.contains("steel") == true)
      #expect(data.defensive.immuneTo == ["electric"])
    } else {
      Issue.record("entity_type should decode to ok/type")
    }
  }

  /// The miss envelopes decode to their non-ok arms.
  @Test
  func entityMissesDecodeToTheirArms() throws {
    guard case let .notFound(miss) = try Fixtures.decode(EntityArtifact.self, from: "entity_not_found.json") else {
      Issue.record("expected a not_found artifact")
      return
    }
    #expect(miss.query == "garchom")
    #expect(miss.suggestions == ["Garchomp"])

    guard case let .unavailable(unavailable) = try Fixtures.decode(EntityArtifact.self, from: "entity_unavailable.json") else {
      Issue.record("expected an unavailable artifact")
      return
    }
    #expect(unavailable.kind == .move)
    #expect(unavailable.format == .champions)
  }

  /// The verify body decodes the additive Bearer `token` + `expiresAt`.
  @Test
  func authVerifyDecodesBearerFields() throws {
    let verify = try Fixtures.decode(AuthVerifyResponse.self, from: "auth_verify.json")
    #expect(verify.ok == true)
    #expect(verify.created == false)
    #expect(verify.email == "trainer@example.com")
    #expect(verify.token.isEmpty == false)
    #expect(verify.expiresAt == 1_722_192_000_000)
  }

  /// `me` decodes both the signed-in and guest branches.
  @Test
  func meDecodesBothBranches() throws {
    let signedIn = try Fixtures.decode(MeResponse.self, from: "me.json")
    #expect(signedIn.signedIn == true)
    #expect(signedIn.email == "trainer@example.com")

    let guest = try Fixtures.decode(MeResponse.self, from: "me_guest.json")
    #expect(guest.signedIn == false)
    #expect(guest.email == nil)
  }

  /// The error envelope decodes `{ code, message }`; `status` is not in the body.
  @Test
  func apiErrorDecodes() throws {
    let error = try Fixtures.decode(APIErrorBody.self, from: "api_error.json")
    #expect(error.code == "rate_limited")
    #expect(error.message.isEmpty == false)
    #expect(error.status == nil)
  }
}

// MARK: - Test-local response envelopes

// The list/`{team,validation}` wrappers aren't standalone DTOs yet (a later
// Services phase formalizes them); the decode suite needs a concrete decode
// target now, so they're defined here from the documented wire shapes.

private struct ConversationsListEnvelope: Decodable {
  let conversations: [ConversationSummary]
}

private struct TeamsListEnvelope: Decodable {
  let teams: [Team]
}

private struct TeamEnvelope: Decodable {
  let team: Team
  let validation: TeamValidationResult
}

// MARK: - Fixture name catalogs (file-scope so the @Test macros can reference them)

/// Every committed `.json` fixture, each decoded into its DTO above.
private let jsonFixtures: [String] = [
  "oakanswer_answered_full.json",
  "oakanswer_clarification.json",
  "oakanswer_resolution_failed.json",
  "oakanswer_insufficient_data.json",
  "conversations_list.json",
  "conversation_detail.json",
  "team.json",
  "teams_list.json",
  "entity_pokemon.json",
  "entity_move.json",
  "entity_ability.json",
  "entity_item.json",
  "entity_type.json",
  "entity_not_found.json",
  "entity_unavailable.json",
  "auth_verify.json",
  "me.json",
  "me_guest.json",
  "api_error.json",
]

/// The four `OakAnswer` status fixtures that additionally round-trip losslessly.
private let oakAnswerFixtures: [String] = [
  "oakanswer_answered_full.json",
  "oakanswer_clarification.json",
  "oakanswer_resolution_failed.json",
  "oakanswer_insufficient_data.json",
]
