import Foundation
import Observation

/// The full-set team editor's view model (history-and-teams.md M-TEAM-US-1/3;
/// component-design.md "TeamEditorViewModel"). Holds the editable team (name + up to 6
/// member sets, each with species / ability / item / four moves / nature / EVs / IVs /
/// Tera / level), drives save (create-or-update), and surfaces the server's
/// **warn-but-allow** validation — warnings are rendered but **never block save**
/// (M-AC-T3.1 / M-BR-T3).
///
/// `@MainActor @Observable` — the editable members are plain value-type structs the
/// SwiftUI form binds to two-way (`$model.members[i].evs.hp`, etc.), so steppers /
/// pickers / text fields edit them directly. Depends on the ``TeamService`` **protocol**
/// (never `LiveTeamService`) so it unit-tests against `FakeTeamService`.
///
/// A team's `format` is fixed for its life (M-BR-T2): it is set at creation and never
/// edited here. Slugs (not display names) are stored/sent (the team data model); the
/// server resolves names and flags anything illegal as an advisory warning.
@MainActor
@Observable
final class TeamEditorViewModel {

  // MARK: Identity

  /// The saved team's id once persisted; `nil` for a brand-new, unsaved team.
  private(set) var teamId: String?

  /// The team's fixed data-scope format (M-BR-T2). Set at creation; never edited.
  let format: Format

  // MARK: Editable state (two-way bound)

  /// The team name (M-AC-T1.1). Trimmed on save; an empty name defaults server-side.
  var name: String

  /// The editable member sets (0…6). Bound field-by-field by the editor form.
  var members: [EditableMember]

  // MARK: Result state

  /// The server's warn-but-allow validation warnings from the last load/save. Rendered,
  /// never blocking (M-AC-T3.1).
  private(set) var warnings: [TeamWarning] = []

  /// The last successfully saved team snapshot (drives "saved" confirmation + export).
  private(set) var savedTeam: Team?

  /// `true` while a save is in flight.
  private(set) var isSaving: Bool = false

  /// `true` while the initial load (existing team) is in flight.
  private(set) var isLoading: Bool = false

  /// A user-facing error message for the last failed operation, or `nil` when clear.
  private(set) var errorMessage: String?

  // MARK: Dependencies

  private let teamService: any TeamService

  // MARK: Init

  /// Opens the editor on a brand-new, unsaved team in `format`, seeded with one empty
  /// member set so the form has something to fill (M-AC-T1.1).
  init(teamService: any TeamService, format: Format, name: String = "") {
    self.teamService = teamService
    self.format = format
    self.name = name
    self.members = [EditableMember()]
  }

  /// Opens the editor on an existing team by its list summary; ``load()`` fetches the
  /// full members + warnings.
  init(teamService: any TeamService, summary: TeamSummary) {
    self.teamService = teamService
    self.teamId = summary.id
    self.format = summary.format
    self.name = summary.name
    self.members = []
  }

  /// Opens the editor on an already-loaded full team (e.g. straight after create /
  /// duplicate / import / apply), with no extra fetch.
  init(teamService: any TeamService, team: Team, warnings: [TeamWarning] = []) {
    self.teamService = teamService
    self.teamId = team.id
    self.format = team.format
    self.name = team.name
    self.members = team.members.map(EditableMember.init(from:))
    self.savedTeam = team
    self.warnings = warnings
  }

  // MARK: Loading

  /// Loads the full team (members + computed warnings) for an existing team
  /// (M-AC-T1.2). A no-op for an unsaved team. Never throws: a failure surfaces as
  /// ``errorMessage``.
  func load() async {
    guard let teamId else { return }
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      let (team, validation) = try await teamService.get(id: teamId)
      apply(saved: team, validation: validation)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
    } catch {
      errorMessage = Self.genericMessage
    }
  }

  // MARK: Member editing

  /// Adds an empty member set (M-AC-T1.1); a no-op at the 6-slot cap (M-BR-T2 roster).
  func addMember() {
    guard members.count < 6 else { return }
    members.append(EditableMember())
  }

  /// Removes the member set at `index`.
  func removeMember(at index: Int) {
    guard members.indices.contains(index) else { return }
    members.remove(at: index)
  }

  /// `true` when another slot can be added (drives the "Add Pokémon" affordance).
  var canAddMember: Bool { members.count < 6 }

  /// The EV total for a slot — shown next to the steppers (warned, never blocked, when
  /// over 508).
  func evTotal(for member: EditableMember) -> Int {
    member.evs.total
  }

  /// Warnings scoped to one member slot (by index), for inline display under the set.
  func warnings(forSlot index: Int) -> [TeamWarning] {
    warnings.filter { $0.slot == index }
  }

  /// Team-level warnings (no slot — e.g. species/item clauses, incompleteness).
  var teamLevelWarnings: [TeamWarning] {
    warnings.filter { $0.slot == nil }
  }

  // MARK: Save (warn-but-allow — never blocked)

  /// Saves the team (create when new, replace when existing). **Never blocked by
  /// warnings** (M-AC-T3.1): the request always goes out, and the returned warnings are
  /// shown afterward. Returns the saved ``Team`` or `nil` on a transport/HTTP failure.
  @discardableResult
  func save() async -> Team? {
    isSaving = true
    errorMessage = nil
    defer { isSaving = false }

    let memberPayload = members.map { $0.asTeamMember() }
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let namePayload = trimmedName.isEmpty ? nil : trimmedName

    do {
      let result: (team: Team, validation: TeamValidationResult)
      if let teamId {
        result = try await teamService.update(id: teamId, name: namePayload, members: memberPayload)
      } else {
        result = try await teamService.create(format: format, name: namePayload, members: memberPayload)
      }
      apply(saved: result.team, validation: result.validation)
      return result.team
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  // MARK: Export

  /// Renders the saved team as Showdown paste text (M-TEAM-US-2). Requires a saved team
  /// (an id); for an unsaved team it surfaces a hint and returns `nil`.
  func exportPaste() async -> String? {
    guard let teamId else {
      errorMessage = "Save the team before exporting."
      return nil
    }
    do {
      return try await teamService.exportPaste(id: teamId)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  /// Clears the current error banner.
  func dismissError() {
    errorMessage = nil
  }

  // MARK: Internals

  /// Adopts a server-returned team as the editor's canonical state — the server may
  /// normalize fields, so the editable rows are rebuilt from the saved members.
  private func apply(saved team: Team, validation: TeamValidationResult) {
    teamId = team.id
    name = team.name
    members = team.members.map(EditableMember.init(from:))
    savedTeam = team
    warnings = validation.warnings
  }

  // MARK: Picker option sets (fixed; no index reads)

  /// The 25 nature slugs, for the nature picker (natures aren't in the searchable index;
  /// the server validates against this same fixed set).
  static let natures: [String] = [
    "hardy", "lonely", "brave", "adamant", "naughty",
    "bold", "docile", "relaxed", "impish", "lax",
    "timid", "hasty", "serious", "jolly", "naive",
    "modest", "mild", "quiet", "bashful", "rash",
    "calm", "gentle", "sassy", "careful", "quirky",
  ]

  /// The 18 type slugs, for the Tera-type picker.
  static let teraTypes: [String] = [
    "normal", "fire", "water", "electric", "grass", "ice",
    "fighting", "poison", "ground", "flying", "psychic", "bug",
    "rock", "ghost", "dragon", "dark", "steel", "fairy",
  ]

  // MARK: Error copy (static so tests can assert exact strings)

  static let connectionMessage = "No connection. Check your network and try again."
  static let sessionExpiredMessage = "Your session expired. Please sign in again."
  static let genericMessage = "Something went wrong. Please try again."

  /// Maps an ``OakError`` to a user-facing message.
  static func message(for error: OakError) -> String {
    switch error {
    case .transport:
      return connectionMessage
    case .rateLimited:
      return "You're going too fast. Please wait a moment and try again."
    case .unauthorized:
      return sessionExpiredMessage
    case let .http(_, _, message):
      return message.isEmpty ? genericMessage : message
    case .decoding, .imageRejected:
      return genericMessage
    }
  }
}

// MARK: - Editable value models (two-way bound by the form)

/// A mutable, form-bindable EV/IV spread. The wire ``StatSpread`` is immutable (`let`),
/// so the editor edits this and converts on save.
struct EditableStatSpread: Equatable, Sendable {
  var hp: Int
  var atk: Int
  var def: Int
  var spa: Int
  var spd: Int
  var spe: Int

  /// The six-stat total (for the EV-budget readout; >508 is warned, never blocked).
  var total: Int { hp + atk + def + spa + spd + spe }

  init(hp: Int = 0, atk: Int = 0, def: Int = 0, spa: Int = 0, spd: Int = 0, spe: Int = 0) {
    self.hp = hp
    self.atk = atk
    self.def = def
    self.spa = spa
    self.spd = spd
    self.spe = spe
  }

  init(from spread: StatSpread) {
    self.init(
      hp: spread.hp, atk: spread.atk, def: spread.def,
      spa: spread.spa, spd: spread.spd, spe: spread.spe
    )
  }

  /// The immutable wire spread for persistence.
  func asStatSpread() -> StatSpread {
    StatSpread(hp: hp, atk: atk, def: def, spa: spa, spd: spd, spe: spe)
  }
}

/// A mutable, form-bindable member set. The wire ``TeamMember`` uses `nil`/optional
/// slugs and a variable-length `moves` array; the editor uses empty strings and a
/// fixed 4-move grid for clean bindings, converting on save (empty → `nil`, blank moves
/// dropped).
struct EditableMember: Identifiable, Equatable, Sendable {
  let id: UUID
  var species: String
  var ability: String
  var item: String
  /// Exactly four move slots (empty string = unset) for a stable form grid.
  var moves: [String]
  var nature: String
  var evs: EditableStatSpread
  var ivs: EditableStatSpread
  var teraType: String
  var level: Int
  var nickname: String
  var gender: TeamMember.Gender?
  var shiny: Bool

  /// A fresh empty slot: no entries, zero EVs, perfect (31) IVs, level 50 (both formats'
  /// default).
  init() {
    self.id = UUID()
    self.species = ""
    self.ability = ""
    self.item = ""
    self.moves = ["", "", "", ""]
    self.nature = ""
    self.evs = EditableStatSpread()
    self.ivs = EditableStatSpread(hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31)
    self.teraType = ""
    self.level = 50
    self.nickname = ""
    self.gender = nil
    self.shiny = false
  }

  /// Builds an editable row from a stored ``TeamMember`` (nil → "", moves padded to 4).
  init(from member: TeamMember) {
    self.id = UUID()
    self.species = member.species ?? ""
    self.ability = member.ability ?? ""
    self.item = member.item ?? ""
    let padded = member.moves + Array(repeating: "", count: max(0, 4 - member.moves.count))
    self.moves = Array(padded.prefix(4))
    self.nature = member.nature ?? ""
    self.evs = EditableStatSpread(from: member.evs)
    self.ivs = EditableStatSpread(from: member.ivs)
    self.teraType = member.teraType ?? ""
    self.level = member.level
    self.nickname = member.nickname ?? ""
    self.gender = member.gender
    self.shiny = member.shiny ?? false
  }

  /// Converts back to the wire ``TeamMember``: trimmed empty strings become `nil`, blank
  /// move slots are dropped, and `shiny` is emitted only when true (server convention).
  func asTeamMember() -> TeamMember {
    func slug(_ value: String) -> String? {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    }
    let resolvedMoves =
      moves
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    return TeamMember(
      species: slug(species),
      ability: slug(ability),
      item: slug(item),
      moves: Array(resolvedMoves.prefix(4)),
      nature: slug(nature),
      evs: evs.asStatSpread(),
      ivs: ivs.asStatSpread(),
      teraType: slug(teraType),
      level: level,
      nickname: slug(nickname),
      gender: gender,
      shiny: shiny ? true : nil
    )
  }
}
