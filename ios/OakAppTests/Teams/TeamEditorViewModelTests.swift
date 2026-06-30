import Foundation
import Testing

@testable import OakApp

/// `TeamEditorViewModel` against `FakeTeamService` (history-and-teams.md M-TEAM-US-1/3):
/// the full-set editor's load, the create-vs-update save path, the **warn-but-allow**
/// guarantee (warnings render but never block save, M-AC-T3.1), member add/remove, the
/// editable↔wire conversion, and export. `@MainActor`.
@MainActor
struct TeamEditorViewModelTests {

  // MARK: Helpers

  private func member(
    species: String?,
    moves: [String] = [],
    evs: StatSpread = .zero,
    ivs: StatSpread = .zero
  ) -> TeamMember {
    TeamMember(
      species: species,
      ability: nil,
      item: nil,
      moves: moves,
      nature: nil,
      evs: evs,
      ivs: ivs,
      teraType: nil,
      level: 50,
      nickname: nil,
      gender: nil,
      shiny: nil
    )
  }

  private func team(
    id: String,
    name: String = "Team",
    format: Format = .scarletViolet,
    members: [TeamMember] = []
  ) -> Team {
    Team(id: id, name: name, format: format, members: members, createdAt: 1, updatedAt: 1)
  }

  // MARK: New editor

  @Test
  func newEditorSeedsOneEmptyMember() {
    let vm = TeamEditorViewModel(teamService: FakeTeamService(), format: .scarletViolet)

    #expect(vm.teamId == nil)
    #expect(vm.members.count == 1)
    #expect(vm.members[0].species.isEmpty)
    #expect(vm.format == .scarletViolet)
  }

  // MARK: Save (create / update)

  @Test
  func saveCreatesWhenNew() async {
    let fake = FakeTeamService()
    let vm = TeamEditorViewModel(teamService: fake, format: .champions, name: "My Team")
    vm.members[0].species = "garchomp"

    let saved = await vm.save()

    #expect(saved != nil)
    #expect(fake.createCount == 1)
    #expect(fake.lastCreateFormat == .champions)
    #expect(fake.lastCreateName == "My Team")
    #expect(fake.lastCreateMembers?.first?.species == "garchomp")
    #expect(vm.teamId == saved?.id)
    #expect(vm.savedTeam?.id == saved?.id)
  }

  @Test
  func saveUpdatesWhenExisting() async {
    let existing = team(id: "t1", name: "Old", members: [member(species: "garchomp")])
    let fake = FakeTeamService(seed: [existing])
    let vm = TeamEditorViewModel(teamService: fake, team: existing)
    vm.name = "New name"

    let saved = await vm.save()

    #expect(saved != nil)
    #expect(fake.updateCount == 1)
    #expect(fake.lastUpdateId == "t1")
    #expect(fake.lastUpdateName == "New name")
    #expect(vm.savedTeam?.name == "New name")
  }

  // MARK: Warn-but-allow — warnings NEVER block save (M-AC-T3.1)

  @Test
  func warningsRenderButNeverBlockSave() async {
    let fake = FakeTeamService()
    fake.nextWarnings = [
      TeamWarning(
        code: .evTotalExceeded,
        message: "EV total is over 508.",
        slot: 0,
        field: "evs"
      ),
      TeamWarning(
        code: .moveNotInLearnset,
        message: "Garchomp can't learn Moonblast.",
        slot: 0,
        field: "moves[0]"
      ),
    ]
    let vm = TeamEditorViewModel(teamService: fake, format: .scarletViolet, name: "Illegal")
    vm.members[0].species = "garchomp"
    vm.members[0].moves[0] = "moonblast"
    vm.members[0].evs = EditableStatSpread(hp: 252, atk: 252, def: 252, spa: 0, spd: 0, spe: 0)

    let saved = await vm.save()

    #expect(saved != nil)  // saved despite the warnings
    #expect(fake.createCount == 1)
    #expect(vm.warnings.count == 2)
    #expect(vm.warnings(forSlot: 0).count == 2)
    #expect(vm.errorMessage == nil)
  }

  @Test
  func saveSurfacesTransportError() async {
    let fake = FakeTeamService()
    fake.createError = .transport(underlying: "URLError.-1009")
    let vm = TeamEditorViewModel(teamService: fake, format: .scarletViolet)

    let saved = await vm.save()

    #expect(saved == nil)
    #expect(vm.errorMessage == TeamEditorViewModel.connectionMessage)
  }

  // MARK: Load

  @Test
  func loadFetchesMembersAndWarnings() async {
    let existing = team(
      id: "t1",
      name: "Loaded",
      members: [member(species: "garchomp", moves: ["earthquake"])]
    )
    let fake = FakeTeamService(seed: [existing])
    fake.nextWarnings = [
      TeamWarning(code: .incomplete, message: "2 of 6 Pokémon.", slot: nil, field: nil)
    ]
    let vm = TeamEditorViewModel(teamService: fake, summary: TeamSummary(team: existing))

    await vm.load()

    #expect(vm.teamId == "t1")
    #expect(vm.members.count == 1)
    #expect(vm.members[0].species == "garchomp")
    #expect(vm.warnings.count == 1)
    #expect(vm.teamLevelWarnings.count == 1)
  }

  // MARK: Member add / remove

  @Test
  func addMemberRespectsSixCap() {
    let vm = TeamEditorViewModel(teamService: FakeTeamService(), format: .scarletViolet)
    // Starts with one seeded slot; add until full, then it must no-op.
    for _ in 0..<10 { vm.addMember() }

    #expect(vm.members.count == 6)
    #expect(vm.canAddMember == false)
  }

  @Test
  func removeMemberDropsSlot() {
    let vm = TeamEditorViewModel(teamService: FakeTeamService(), format: .scarletViolet)
    vm.addMember()
    vm.members[0].species = "first"
    vm.members[1].species = "second"

    vm.removeMember(at: 0)

    #expect(vm.members.count == 1)
    #expect(vm.members[0].species == "second")
  }

  // MARK: Editable ↔ wire conversion

  @Test
  func conversionDropsBlanksAndCompactsMoves() async {
    let fake = FakeTeamService()
    let vm = TeamEditorViewModel(teamService: fake, format: .scarletViolet)
    vm.members[0].species = "   "  // blank → nil
    vm.members[0].moves = ["earthquake", "", "  ", "dragon-claw"]

    _ = await vm.save()

    let saved = fake.lastCreateMembers?.first
    #expect(saved?.species == nil)
    #expect(saved?.moves == ["earthquake", "dragon-claw"])
  }

  // MARK: Export

  @Test
  func exportRequiresSavedTeam() async {
    let vm = TeamEditorViewModel(teamService: FakeTeamService(), format: .scarletViolet)

    let paste = await vm.exportPaste()

    #expect(paste == nil)
    #expect(vm.errorMessage != nil)
  }

  @Test
  func exportReturnsPasteForSavedTeam() async {
    let existing = team(id: "t1", members: [member(species: "garchomp", moves: ["earthquake"])])
    let fake = FakeTeamService(seed: [existing])
    let vm = TeamEditorViewModel(teamService: fake, team: existing)

    let paste = await vm.exportPaste()

    #expect(paste != nil)
    #expect(fake.exportCount == 1)
    #expect(fake.lastExportId == "t1")
  }
}
