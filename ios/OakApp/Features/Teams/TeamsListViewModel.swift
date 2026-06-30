import Foundation
import Observation

/// The team-library view model (history-and-teams.md M-TEAM-US-6; component-design.md
/// "TeamsListViewModel"). Holds the team list and the format-filter state, drives the
/// library mutations (create / duplicate / delete), folds in agent-applied and imported
/// teams, and binds a saved team as the **active team** for the current conversation
/// (M-TEAM-US-5).
///
/// `@MainActor @Observable` — all state mutates on the main actor and views observe it
/// directly. It depends on the ``TeamService`` and ``HistoryService`` **protocols**
/// (never the `Live…` concretes) so it unit-tests against `FakeTeamService` /
/// `FakeHistoryService`.
///
/// Teams are signed-in only (M-BR-T1): a guest gets `401` from the routes, so the view
/// shows a sign-in prompt rather than this list. The format filter (`?format=`) is
/// applied **server-side** — changing it re-fetches via ``reload()``.
@MainActor
@Observable
final class TeamsListViewModel {

  // MARK: List state

  /// The visible team summaries, most-recently-edited first (the server's order).
  private(set) var teams: [TeamSummary] = []

  /// `true` while a list fetch is in flight (drives the refresh spinner).
  private(set) var isLoading: Bool = false

  /// A user-facing error message for the last failed operation, or `nil` when clear.
  private(set) var errorMessage: String?

  /// The id of the team bound active for the current conversation (M-AC-T5.3), or `nil`.
  /// Reflects the conversation's `active_team_id`; set via ``setActive(_:conversationId:)``
  /// and primed on open with ``primeActiveTeam(_:)``.
  private(set) var activeTeamId: String?

  // MARK: Filter state

  /// The active format filter (M-TEAM-US-6); `nil` = all formats. Applied server-side.
  private(set) var formatFilter: Format?

  // MARK: Dependencies

  private let teamService: any TeamService
  private let history: any HistoryService

  init(teamService: any TeamService, history: any HistoryService) {
    self.teamService = teamService
    self.history = history
  }

  // MARK: Loading

  /// (Re)loads the team list with the current filter — the initial load,
  /// pull-to-refresh, and the re-fetch after a filter change all route through here.
  /// Never throws: a failure surfaces as ``errorMessage`` and leaves the prior list.
  func reload() async {
    isLoading = true
    errorMessage = nil
    defer { isLoading = false }
    do {
      teams = try await teamService.list(format: formatFilter)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
    } catch {
      errorMessage = Self.genericMessage
    }
  }

  /// Switches the format filter and re-fetches (M-TEAM-US-6). A no-op when unchanged.
  func setFormatFilter(_ format: Format?) async {
    guard format != formatFilter else { return }
    formatFilter = format
    await reload()
  }

  // MARK: Library mutations

  /// Creates a new, empty team in the given format (M-TEAM-US-1) and inserts its
  /// summary at the top. Returns the created ``Team`` (for handing straight to the
  /// editor), or `nil` on failure. `name == nil` ⇒ the server's default name.
  @discardableResult
  func createTeam(format: Format, name: String? = nil) async -> Team? {
    do {
      let (team, _) = try await teamService.create(format: format, name: name, members: nil)
      insertOrReplace(TeamSummary(team: team))
      return team
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  /// Duplicates a team (M-TEAM-US-6) and inserts the copy's summary at the top.
  @discardableResult
  func duplicate(_ summary: TeamSummary) async -> Team? {
    do {
      let (team, _) = try await teamService.duplicate(id: summary.id)
      insertOrReplace(TeamSummary(team: team))
      return team
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  /// Deletes a team (M-TEAM-US-6). Optimistically removes the row, then persists. A
  /// `404` is treated as success (already gone — idempotent UX); any other failure
  /// restores the row and surfaces an error. Clears the active binding if it pointed
  /// at the deleted team (the server nulls the conversation reference too).
  func delete(_ summary: TeamSummary) async {
    let snapshot = teams
    teams.removeAll { $0.id == summary.id }
    if activeTeamId == summary.id { activeTeamId = nil }
    do {
      try await teamService.delete(id: summary.id)
    } catch OakError.http(let status, _, _) where status == 404 {
      // Already deleted on the server — keep it removed (idempotent).
    } catch let error as OakError {
      teams = snapshot
      errorMessage = Self.message(for: error)
    } catch {
      teams = snapshot
      errorMessage = Self.genericMessage
    }
  }

  // MARK: Apply proposed (agent-assisted) & import

  /// Applies an agent-proposed team to saved storage as a **new** team
  /// (M-TEAM-US-4 / M-BR-T4 — applying is always an explicit user action), then inserts
  /// its summary at the top. This is the real implementation the AnswerCard's "Apply"
  /// action routes to (`POST /api/teams` with the proposed name/format/members). Returns
  /// the saved ``Team`` or `nil` on failure.
  @discardableResult
  func applyProposed(_ proposed: ProposedTeam) async -> Team? {
    do {
      let (team, _) = try await teamService.create(
        format: proposed.format,
        name: proposed.name,
        members: proposed.members
      )
      insertOrReplace(TeamSummary(team: team))
      return team
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  /// Imports a Showdown paste into a new saved team (M-TEAM-US-2) and inserts its
  /// summary. Returns the saved team and any resolve-or-clarify ``ImportNote``s (the
  /// import never fails wholesale), or `nil` on a transport/HTTP failure.
  @discardableResult
  func importPaste(_ paste: String, format: Format) async -> (team: Team, notes: [ImportNote])? {
    do {
      let (team, _, notes) = try await teamService.importPaste(format: format, paste: paste)
      insertOrReplace(TeamSummary(team: team))
      return (team, notes)
    } catch let error as OakError {
      errorMessage = Self.message(for: error)
      return nil
    } catch {
      errorMessage = Self.genericMessage
      return nil
    }
  }

  // MARK: Active-team binding (M-TEAM-US-5)

  /// Primes the active-team selection from a conversation's `active_team_id` on open
  /// (M-AC-T5.3) — a local set, no network.
  func primeActiveTeam(_ teamId: String?) {
    activeTeamId = teamId
  }

  /// Sets (or clears, `team == nil`) the active team for the given conversation
  /// (M-AC-T5.1 / reconciliation #1: active team is persisted on the conversation via
  /// `PATCH /api/conversations/{id}`, NOT carried on the chat request body). Optimistic:
  /// reflects the selection immediately, then persists; a failure reverts and surfaces
  /// an error. The server validates ownership + format match and silently ignores an
  /// invalid id (warn-but-allow), so this never throws in-domain.
  func setActive(_ team: TeamSummary?, conversationId: String) async {
    let previous = activeTeamId
    activeTeamId = team?.id
    do {
      try await history.setActiveTeam(id: conversationId, teamId: team?.id)
    } catch let error as OakError {
      activeTeamId = previous
      errorMessage = Self.message(for: error)
    } catch {
      activeTeamId = previous
      errorMessage = Self.genericMessage
    }
  }

  /// Clears the current error banner.
  func dismissError() {
    errorMessage = nil
  }

  // MARK: Child editor factories

  /// An editor for a brand-new, unsaved team in `format` (the "+" flow). The editor's
  /// own Save persists it; the list reloads on return.
  func makeEditor(forNewTeam format: Format) -> TeamEditorViewModel {
    TeamEditorViewModel(teamService: teamService, format: format)
  }

  /// An editor for an existing team (by summary); the editor's ``TeamEditorViewModel/load()``
  /// fetches the full members + warnings.
  func makeEditor(for summary: TeamSummary) -> TeamEditorViewModel {
    TeamEditorViewModel(teamService: teamService, summary: summary)
  }

  /// An editor for an already-loaded full team (e.g. a freshly applied/imported team),
  /// with no extra fetch.
  func makeEditor(for team: Team) -> TeamEditorViewModel {
    TeamEditorViewModel(teamService: teamService, team: team)
  }

  // MARK: Local list edits

  /// Inserts a summary at the top, or replaces the existing row with the same id and
  /// moves it to the top (mirrors the server's most-recently-edited-first ordering for
  /// a freshly created/updated team).
  private func insertOrReplace(_ summary: TeamSummary) {
    teams.removeAll { $0.id == summary.id }
    teams.insert(summary, at: 0)
  }

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

// MARK: - Summary from a full team

extension TeamSummary {
  /// Derives the list-row summary from a full ``Team`` (returned by create / duplicate /
  /// import / apply) so a freshly persisted team can join the list without a re-fetch.
  /// Mirrors the server's `listTeams` projection: filled-slot species, a member count,
  /// and the cheap "incomplete" rule (<6 members, or any slot missing a species / its
  /// 4th move).
  init(team: Team) {
    self.init(
      id: team.id,
      name: team.name,
      format: team.format,
      memberCount: team.members.count,
      incomplete: team.members.count < 6
        || team.members.contains { $0.species == nil || $0.moves.count < 4 },
      species: team.members.compactMap(\.species),
      updatedAt: team.updatedAt
    )
  }
}
