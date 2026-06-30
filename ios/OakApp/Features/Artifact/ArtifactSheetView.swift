import SwiftUI

/// The artifact viewer's **draggable bottom sheet** over the chat (artifact-viewer.md
/// M-ART-US-2/3, M-AC-A1.2/A2.2/A3.2/A3.3, M-BR-ART-1/5).
///
/// Presented via the ``SwiftUICore/View/artifactViewer(_:)`` modifier as a `.sheet` with
/// `presentationDetents([.medium, .large])` — the user keeps chat context above the
/// partially-raised sheet, drags it toward full screen for dense content, and dismisses it with
/// the standard swipe-down gesture (M-AC-A3.3) or the Done control. It shows the **top** of the
/// view model's back stack (one artifact at a time, M-BR-ART-1); a Back control appears once the
/// user has drilled in (M-AC-A3.2). Tapping an entity inside the current artifact pushes a new
/// one (M-AC-A3.1).
///
/// Reads ``ArtifactViewModel`` directly (`@Observable`); the model owns all navigation, so this
/// view is a thin renderer + toolbar.
struct ArtifactSheetView: View {
  let model: ArtifactViewModel

  var body: some View {
    NavigationStack {
      Group {
        if let artifact = model.current {
          content(for: artifact)
        } else {
          Color.clear
        }
      }
      .navigationTitle(model.current?.title ?? "")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        if model.canGoBack {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              model.back()
            } label: {
              Label("Back", systemImage: "chevron.left")
            }
            .accessibilityLabel("Back to previous artifact")
          }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") {
            model.dismiss()
          }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  // MARK: Content dispatch

  @ViewBuilder
  private func content(for artifact: Artifact) -> some View {
    switch artifact.content {
    case .loading:
      loadingView
    case .entity(let ok):
      EntityDetailView(artifact: ok) { kind, query in
        Task { await model.openEntity(kind: kind, query: query) }
      }
    case .team(let team):
      TeamArtifactDetail(team: team) { species in
        Task { await model.openEntity(kind: .pokemon, query: species) }
      }
    case .unavailable(let kind, let query):
      missView(
        title: "Couldn't open \(query)",
        message: "Oak doesn't have a \(kind.rawValue) profile for \u{201C}\(query)\u{201D} in this format."
      )
    case .teamUnavailable:
      missView(
        title: "Couldn't load this team",
        message: "The team couldn't be loaded. It may have been deleted, or you may need to sign in."
      )
    }
  }

  private var loadingView: some View {
    VStack(spacing: 12) {
      ProgressView()
      Text("Loading\u{2026}")
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textSecondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  /// An honest miss — the sheet stays open and the user can always get back to chat
  /// (M-BR-ART-5). Icon + text, never color alone (M-AC-UI9.3).
  private func missView(title: String, message: String) -> some View {
    ContentUnavailableView {
      Label(title, systemImage: "questionmark.circle")
    } description: {
      Text(message)
    }
  }
}

// MARK: - Host modifier

extension View {
  /// Hosts the artifact bottom sheet over `self`, driven by the view model's back stack. Apply it
  /// once on the chat screen; pushing an artifact opens the sheet, an empty stack closes it, and a
  /// swipe-down (or Done) dismisses it (M-AC-A3.3, M-BR-ART-5).
  func artifactViewer(_ model: ArtifactViewModel) -> some View {
    modifier(ArtifactViewerModifier(model: model))
  }
}

/// Binds the sheet's presentation to the model's `isPresented` (stack non-empty) and routes a
/// swipe-down dismissal back to ``ArtifactViewModel/dismiss()`` so the back stack is cleared.
private struct ArtifactViewerModifier: ViewModifier {
  let model: ArtifactViewModel

  func body(content: Content) -> some View {
    content.sheet(
      isPresented: Binding(
        get: { model.isPresented },
        set: { presented in
          if !presented { model.dismiss() }
        }
      )
    ) {
      ArtifactSheetView(model: model)
    }
  }
}

// MARK: - Team artifact

/// Renders a team sheet in the viewer — the agent's **proposed** team (inline, no fetch) or a
/// fetched **saved** team. Mirrors the proposed/saved team cards' fidelity (full member sets +
/// warn-but-allow warnings) but as a focused, scrollable artifact. Each filled member's species
/// is tappable to drill into that Pokémon (M-AC-A3.1).
private struct TeamArtifactDetail: View {
  let team: TeamArtifact
  var onOpenSpecies: (String) -> Void = { _ in }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        header
        if !team.warnings.isEmpty {
          warningsSection
        }
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(team.members.enumerated()), id: \.offset) { index, member in
            memberRow(index: index, member: member)
          }
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
    }
  }

  private var header: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Text(team.savedId == nil ? "Proposed team" : "Saved team")
          .font(Theme.body(.caption).weight(.semibold))
          .foregroundStyle(Theme.accent)
        Text(team.name)
          .font(Theme.display(.title3))
          .foregroundStyle(Theme.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      Text(formatLabel(team.format))
        .font(Theme.body(.caption2).weight(.semibold))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .foregroundStyle(Theme.textSecondary)
        .background(Theme.surfaceRaised, in: Capsule())
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var warningsSection: some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Legality", systemImage: "checklist")
        .font(Theme.body(.caption).weight(.semibold))
        .foregroundStyle(Theme.textSecondary)
      ForEach(Array(team.warnings.enumerated()), id: \.offset) { _, warning in
        Label {
          Text(warning.message)
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textPrimary)
            .fixedSize(horizontal: false, vertical: true)
        } icon: {
          Image(systemName: warning.code == .incomplete ? "info.circle" : "exclamationmark.triangle.fill")
            .imageScale(.small)
            .foregroundStyle(warning.code == .incomplete ? Theme.info : Theme.warning)
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(Theme.warning.opacity(0.10), in: RoundedRectangle(cornerRadius: Theme.Radius.md))
  }

  @ViewBuilder
  private func memberRow(index: Int, member: TeamMember) -> some View {
    let species = (member.species ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let isEmpty = species.isEmpty
    HStack(alignment: .top, spacing: 8) {
      Text("\(index + 1)")
        .font(Theme.mono(.caption2))
        .foregroundStyle(Theme.textSecondary)
        .frame(minWidth: 16, alignment: .trailing)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 3) {
        if isEmpty {
          Text("Empty slot")
            .font(Theme.body(.subheadline).weight(.semibold))
            .foregroundStyle(Theme.textMuted)
        } else {
          Button {
            onOpenSpecies(species)
          } label: {
            HStack(spacing: 6) {
              Text(titleize(species) + itemSuffix(member.item))
                .font(Theme.body(.subheadline).weight(.semibold))
                .foregroundStyle(Theme.textPrimary)
                .multilineTextAlignment(.leading)
              Image(systemName: "chevron.right")
                .imageScale(.small)
                .foregroundStyle(Theme.textMuted)
            }
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .accessibilityHint("Opens \(titleize(species))")
        }
        if let detail = abilityTeraLine(member) {
          Text(detail)
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        if !member.moves.isEmpty {
          Text(member.moves.map(titleize).joined(separator: ", "))
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private func itemSuffix(_ item: String?) -> String {
    guard let item, !item.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return ""
    }
    return " @ \(titleize(item))"
  }

  private func abilityTeraLine(_ member: TeamMember) -> String? {
    var parts: [String] = []
    if let ability = member.ability, !ability.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      parts.append(titleize(ability))
    }
    if let tera = member.teraType, !tera.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      parts.append("Tera \(titleize(tera))")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
  }
}

// MARK: - File-scoped helpers

/// Title-cases a slug (`great-tusk` → `Great Tusk`). Private to this file to avoid cross-phase
/// collisions (the same recipe is file-scoped in other AnswerCard files).
private func titleize(_ slug: String) -> String {
  slug
    .split(whereSeparator: { $0 == "-" || $0 == " " || $0 == "_" })
    .map { $0.prefix(1).uppercased() + $0.dropFirst() }
    .joined(separator: " ")
}

private func formatLabel(_ format: Format) -> String {
  switch format {
  case .scarletViolet: return "Scarlet/Violet"
  case .champions: return "Champions"
  }
}

#if DEBUG
#Preview("Team artifact") {
  TeamArtifactDetail(
    team: TeamArtifact(
      name: "Sun Offense",
      format: .scarletViolet,
      members: [
        TeamMember(
          species: "great-tusk", ability: "protosynthesis", item: "booster-energy",
          moves: ["headlong-rush", "close-combat", "ice-spinner", "rapid-spin"],
          nature: "jolly", evs: StatSpread(hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252),
          ivs: StatSpread(hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31),
          teraType: "ground", level: 50, nickname: nil, gender: nil, shiny: nil
        )
      ],
      warnings: [
        TeamWarning(code: .incomplete, message: "This team has 1 of 6 Pokémon.", slot: nil, field: nil)
      ],
      savedId: nil
    )
  )
}
#endif
