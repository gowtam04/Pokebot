import Foundation
import Observation

/// Drives the artifact bottom sheet (artifact-viewer.md M-ART-US-1/2/3, M-BR-ART-1/4/5).
///
/// The viewer behaves like a small in-app browser over the chat: it shows **one artifact at a
/// time** (M-BR-ART-1) and keeps a **back stack** so drilling from one artifact into another
/// (a Pokémon → one of its moves, a team → a member) pushes a new entry, and a back control
/// returns to the previous one (M-ART-US-3). The visible artifact is always the top of the
/// stack; an empty stack means the sheet is closed.
///
/// `@MainActor @Observable` — all state mutates on the main actor and the sheet observes it
/// directly. It depends on the ``ArtifactService`` **protocol** (never `LiveArtifactService`)
/// so it unit-tests against `FakeArtifactService`. Entity/saved-team artifacts fetch through the
/// service; a **proposed-team** artifact uses the inline data already delivered with the answer,
/// so opening it is instant with no round-trip (M-AC-A4.1).
///
/// Honest failure (M-BR-ART-5, conventions.md ArtifactService policy): a fetch that comes back
/// `nil` / `not_found` / `unavailable` resolves the entry to an `.unavailable` state rather than
/// throwing or silently popping it — the sheet stays open and the user can always get back to
/// chatting with a single gesture.
@MainActor
@Observable
final class ArtifactViewModel {

  /// The back stack. The **last** element is the visible artifact (one at a time, M-BR-ART-1);
  /// an empty stack closes the sheet.
  private(set) var stack: [Artifact] = []

  // MARK: Dependencies

  private let service: any ArtifactService
  /// The active data scope for entity fetches (M-BR-ART-4) — derived from the chat's mode and
  /// fixed for the viewer's lifetime, so the model has no way to widen scope.
  private let format: Format

  init(service: any ArtifactService, format: Format) {
    self.service = service
    self.format = format
  }

  // MARK: Derived presentation state

  /// The currently visible artifact (top of the stack), or `nil` when the viewer is closed.
  var current: Artifact? { stack.last }

  /// Whether the sheet should be presented — drives the host's `.sheet(isPresented:)` binding.
  var isPresented: Bool { !stack.isEmpty }

  /// Whether a back control belongs in the sheet (more than one artifact on the stack).
  var canGoBack: Bool { stack.count > 1 }

  // MARK: Opening artifacts (push)

  /// Opens an entity (Pokémon/move/ability/item/type) by resolving its full profile for the
  /// active format (M-ART-US-1, M-BR-ART-4). Pushes a `.loading` entry immediately so the sheet
  /// responds at once, then fills it in when the fetch returns; a `nil`/`not_found`/`unavailable`
  /// result resolves to `.unavailable` so the sheet never breaks. `async` so the View can fire it
  /// in a `Task` and tests can await the settled state.
  func openEntity(kind: EntityKind, query: String) async {
    let entry = Artifact(title: query, content: .loading)
    stack.append(entry)
    let result = await service.entity(kind: kind, q: query, format: format)
    guard let index = stack.firstIndex(where: { $0.id == entry.id }) else { return }
    if case .ok(let ok)? = result {
      stack[index] = Artifact(id: entry.id, title: ok.resolved.displayName, content: .entity(ok))
    } else {
      stack[index] = Artifact(
        id: entry.id,
        title: query,
        content: .unavailable(kind: kind, query: query)
      )
    }
  }

  /// Opens the agent's **proposed team** using the INLINE data already delivered with the answer
  /// (no fetch — M-AC-A4.1). Synchronous: the team sheet appears instantly.
  func openProposedTeam(_ team: ProposedTeam, warnings: [TeamWarning]) {
    let artifact = TeamArtifact(
      name: team.name,
      format: team.format,
      members: team.members,
      warnings: warnings,
      savedId: nil
    )
    stack.append(Artifact(title: team.name, content: .team(artifact)))
  }

  /// Opens a **saved team** by id, fetching its members + warnings fresh (M-AC-A3.2: the
  /// saved-team card's "Open in viewer"). Pushes a `.loading` entry, then resolves to the team or
  /// `.teamUnavailable` if it can't be loaded.
  func openSavedTeam(id: String, name: String) async {
    let entry = Artifact(title: name, content: .loading)
    stack.append(entry)
    let result = await service.savedTeam(id: id)
    guard let index = stack.firstIndex(where: { $0.id == entry.id }) else { return }
    if let result {
      let artifact = TeamArtifact(
        name: result.team.name,
        format: result.team.format,
        members: result.team.members,
        warnings: result.validation.warnings,
        savedId: result.team.id
      )
      stack[index] = Artifact(id: entry.id, title: result.team.name, content: .team(artifact))
    } else {
      stack[index] = Artifact(id: entry.id, title: name, content: .teamUnavailable)
    }
  }

  // MARK: Navigation

  /// Returns to the previous artifact (M-AC-A3.2). At the root, backing out dismisses the sheet.
  func back() {
    guard stack.count > 1 else {
      dismiss()
      return
    }
    stack.removeLast()
  }

  /// Closes the viewer and clears the back stack — the single-gesture return to chat
  /// (M-AC-A3.3, M-BR-ART-5). Artifacts are ephemeral (M-BR-ART-2), so nothing is persisted.
  func dismiss() {
    stack.removeAll()
  }
}

// MARK: - Artifact model

/// One entry on the viewer's back stack: a stable identity, the title shown in the sheet's nav
/// bar, and the content to render. A value type whose `content` is replaced in place as an async
/// fetch settles.
struct Artifact: Identifiable, Sendable {
  let id: UUID
  var title: String
  var content: ArtifactContent

  init(id: UUID = UUID(), title: String, content: ArtifactContent) {
    self.id = id
    self.title = title
    self.content = content
  }
}

/// What an ``Artifact`` is showing — a small closed set mirroring the web viewer's artifact
/// kinds (entity profile, team sheet) plus the transient loading/miss states the native sheet
/// needs. Artifacts are ephemeral (M-BR-ART-2); this is never persisted.
enum ArtifactContent: Sendable {
  /// Awaiting a fetch (entity or saved team).
  case loading
  /// A resolved entity profile (Pokémon/move/ability/item/type) — rendered by ``EntityDetailView``.
  case entity(EntityArtifactOk)
  /// A team sheet — the agent's proposed team (inline) or a fetched saved team.
  case team(TeamArtifact)
  /// An entity that couldn't be shown (`not_found` / `unavailable` / transport) — an honest miss
  /// (M-BR-ART-5), carrying the original kind + query for the message.
  case unavailable(kind: EntityKind, query: String)
  /// A saved team that couldn't be loaded.
  case teamUnavailable
}

/// A team rendered in the viewer — unified across the agent's **proposed** team (inline, no
/// fetch) and a **saved** team (fetched). `savedId` is non-nil only for a saved team.
struct TeamArtifact: Sendable, Equatable {
  let name: String
  let format: Format
  let members: [TeamMember]
  let warnings: [TeamWarning]
  /// The team's id when it is a persisted saved team; `nil` for an ephemeral proposed team.
  let savedId: String?
}
