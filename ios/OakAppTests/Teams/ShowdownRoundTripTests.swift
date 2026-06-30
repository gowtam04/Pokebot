import Foundation
import Testing

@testable import OakApp

/// Showdown export→import round-trip at the client layer (history-and-teams.md
/// M-TEAM-US-2 / M-BR-T5): a team exported via the editor's ``TeamEditorViewModel/exportPaste()``
/// re-imports via the list's ``TeamsListViewModel/importPaste(_:format:)`` reproducing its
/// members exactly. The ``FakeTeamService`` serializes/parses the members through the
/// "paste" so this verifies the client plumbing honors the round-trip contract the real
/// backend guarantees through Showdown text.
@MainActor
struct ShowdownRoundTripTests {

  private func fullMember() -> TeamMember {
    TeamMember(
      species: "great-tusk",
      ability: "protosynthesis",
      item: "booster-energy",
      moves: ["headlong-rush", "close-combat", "ice-spinner", "rapid-spin"],
      nature: "jolly",
      evs: StatSpread(hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252),
      ivs: StatSpread(hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31),
      teraType: "ground",
      level: 50,
      nickname: "Tusker",
      gender: .neutral,
      shiny: true
    )
  }

  private func partialMember() -> TeamMember {
    TeamMember(
      species: "flutter-mane",
      ability: nil,
      item: nil,
      moves: ["moonblast"],
      nature: nil,
      evs: .zero,
      ivs: StatSpread(hp: 31, atk: 0, def: 31, spa: 31, spd: 31, spe: 31),
      teraType: nil,
      level: 50,
      nickname: nil,
      gender: nil,
      shiny: nil
    )
  }

  @Test
  func exportThenImportReproducesMembers() async {
    let members = [fullMember(), partialMember()]
    let source = Team(
      id: "t1",
      name: "Round Trip",
      format: .scarletViolet,
      members: members,
      createdAt: 1,
      updatedAt: 1
    )
    let fake = FakeTeamService(seed: [source])

    // Export from the editor…
    let editor = TeamEditorViewModel(teamService: fake, team: source)
    let paste = await editor.exportPaste()
    #expect(paste != nil)

    // …then import through the list.
    let listVM = TeamsListViewModel(teamService: fake, history: FakeHistoryService())
    let result = await listVM.importPaste(paste!, format: .scarletViolet)

    #expect(result != nil)
    #expect(result?.notes.isEmpty == true)  // a clean round-trip resolves everything
    #expect(result?.team.members == members)  // members reproduced exactly
    #expect(listVM.teams.contains { $0.id == result?.team.id })
  }

  @Test
  func emptyTeamRoundTrips() async {
    let source = Team(
      id: "empty",
      name: "Empty",
      format: .champions,
      members: [],
      createdAt: 1,
      updatedAt: 1
    )
    let fake = FakeTeamService(seed: [source])

    let editor = TeamEditorViewModel(teamService: fake, team: source)
    let paste = await editor.exportPaste()
    let listVM = TeamsListViewModel(teamService: fake, history: FakeHistoryService())
    let result = await listVM.importPaste(paste ?? "", format: .champions)

    #expect(result?.team.members.isEmpty == true)
  }
}
