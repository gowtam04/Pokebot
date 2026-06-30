import SwiftUI

/// Renders an answer's team-builder blocks — the agent's `proposed_team` (with its
/// server-stamped `proposed_team_warnings`) and/or the `saved_team` reference for a
/// team persisted this turn (M-AC-1.2 / M-SUCCESS-3 — full structural fidelity).
///
/// Mirrors the web `ProposedTeamCard` + `SavedTeamCard`:
///   - **Proposed team** — a buildable team the user can **Apply**. The member
///     sets (species @ item · ability · Tera · moves) are listed, legality/validity
///     warnings are shown inline as **warn-but-allow** advisories (never blocking,
///     BR-T5/BR-T6), and an "Apply" affordance lets the user save it. Applying is an
///     **explicit user action** (M-BR-T4): tapping "Apply" calls ``onApply``, which the
///     chat host routes to `TeamsListViewModel.applyProposed` → `POST /api/teams`
///     (apply-as-new), and the button swaps to an in-place "Saved to your Teams"
///     confirmation. `onApply` defaults to a no-op so the view still builds in isolation
///     / previews.
///   - **Saved team** — the persistent "Saved ✓" confirmation (server-stamped after
///     a `save_team` call) with an "Open in viewer" action (`onOpenSavedTeam`,
///     wired by the artifact phase).
///
/// Renders **nothing** when neither field is present (the render-if-present rule the
/// rest of the AnswerCard tree follows). Warnings carry an icon **and** text, never
/// color alone (M-AC-UI9.3); all type uses `Theme`'s Dynamic-Type styles and wraps
/// (`fixedSize` vertical) so the blocks reflow rather than clip at large sizes and
/// adapt to light/dark (M-AC-1.4 / M-UI-US-9).
struct TeamBlocksView: View {
  /// The agent's proposed team (model-emitted). `nil` ⇒ no proposed-team block.
  let proposedTeam: ProposedTeam?
  /// Roster/legality warnings for `proposedTeam` (server-stamped). Empty ⇒ clean.
  var proposedTeamWarnings: [TeamWarning] = []
  /// The team the agent saved this turn (server-stamped). `nil` ⇒ no saved block.
  let savedTeam: SavedTeamRef?

  /// Saves the proposed team to the user's Teams (`POST /api/teams`). The chat host
  /// routes this to `TeamsListViewModel.applyProposed`; it defaults to a no-op so the
  /// view builds in isolation / previews. Applying is always an explicit user action
  /// (M-BR-T4) — Oak never silently overwrites saved teams.
  var onApply: (ProposedTeam) -> Void = { _ in }
  /// Opens a saved team in the artifact viewer (fetched fresh by id). Wired by the
  /// artifact phase; a no-op placeholder for now.
  var onOpenSavedTeam: (SavedTeamRef) -> Void = { _ in }

  /// Tracks the explicit-apply state so the button can confirm in place once the user
  /// applies the proposed team (M-AC-T4.2). Local to the rendered answer.
  @State private var didApply = false

  /// Explicit memberwise initializer — pinned so the (now `private`-state-carrying) view
  /// keeps the exact construction signature `AnswerCardView` and the previews already use
  /// (a synthesized memberwise init would turn private once `didApply` was added).
  init(
    proposedTeam: ProposedTeam?,
    proposedTeamWarnings: [TeamWarning] = [],
    savedTeam: SavedTeamRef?,
    onApply: @escaping (ProposedTeam) -> Void = { _ in },
    onOpenSavedTeam: @escaping (SavedTeamRef) -> Void = { _ in }
  ) {
    self.proposedTeam = proposedTeam
    self.proposedTeamWarnings = proposedTeamWarnings
    self.savedTeam = savedTeam
    self.onApply = onApply
    self.onOpenSavedTeam = onOpenSavedTeam
  }

  var body: some View {
    // Render-if-present: emit nothing unless there is a team block to show.
    if proposedTeam != nil || savedTeam != nil {
      VStack(alignment: .leading, spacing: 12) {
        if let proposedTeam {
          proposedCard(proposedTeam)
        }
        if let savedTeam {
          savedCard(savedTeam)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: Proposed team

  private func proposedCard(_ team: ProposedTeam) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      proposedHeader(team)

      VStack(alignment: .leading, spacing: 8) {
        ForEach(Array(team.members.enumerated()), id: \.offset) { index, member in
          memberRow(index: index, member: member)
        }
      }

      if !proposedTeamWarnings.isEmpty {
        warningsSection(proposedTeamWarnings)
      }

      applyControl(team)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(
      Theme.surface,
      in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
        .strokeBorder(Theme.accent.opacity(0.25))
    )
  }

  /// The explicit "Apply" affordance (M-AC-T4.2). Before applying, a prominent button
  /// that calls ``onApply`` (the host saves it via `POST /api/teams`); after applying, an
  /// in-place "Saved to your Teams" confirmation — an icon **and** text, never color
  /// alone (M-AC-UI9.3).
  @ViewBuilder
  private func applyControl(_ team: ProposedTeam) -> some View {
    if didApply {
      Label("Saved to your Teams", systemImage: "checkmark.seal.fill")
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.success)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("Saved \(team.name) to your Teams")
    } else {
      Button {
        onApply(team)
        didApply = true
      } label: {
        Label("Apply", systemImage: "square.and.arrow.down")
          .font(Theme.display(.subheadline))
          .frame(maxWidth: .infinity)
      }
      .buttonStyle(.borderedProminent)
      .tint(Theme.accent)
      .accessibilityHint("Save this proposed team to your Teams")
    }
  }

  /// Eyebrow ("Proposed team") + the team name, with a trailing format badge.
  private func proposedHeader(_ team: ProposedTeam) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      VStack(alignment: .leading, spacing: 2) {
        Label("Proposed team", systemImage: "person.3.sequence.fill")
          .labelStyle(.titleAndIcon)
          .font(Theme.body(.caption).weight(.semibold))
          .foregroundStyle(Theme.accent)
        Text(team.name)
          .font(Theme.display(.headline))
          .foregroundStyle(Theme.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      formatBadge(team.format)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Proposed team: \(team.name), \(team.format.displayLabel)")
  }

  /// One member set: numbered, species (with held item), ability/tera, and moves.
  private func memberRow(index: Int, member: TeamMember) -> some View {
    let species = Self.titleize(member.species)
    let isEmpty = (member.species ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

    return HStack(alignment: .top, spacing: 8) {
      Text("\(index + 1)")
        .font(Theme.mono(.caption2))
        .foregroundStyle(Theme.textSecondary)
        .frame(minWidth: 16, alignment: .trailing)
        .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 2) {
        // Species @ item (the headline line of the set).
        (Text(isEmpty ? "Empty slot" : species)
          .font(Theme.body(.subheadline).weight(.semibold))
          .foregroundStyle(isEmpty ? Theme.textMuted : Theme.textPrimary)
          + itemSuffix(member.item))
          .fixedSize(horizontal: false, vertical: true)

        if let detail = abilityTeraLine(member) {
          Text(detail)
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        if !member.moves.isEmpty {
          Text(member.moves.map(Self.titleizeNonNil).joined(separator: ", "))
            .font(Theme.body(.footnote))
            .foregroundStyle(Theme.textMuted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(memberAccessibilityLabel(index: index, member: member, isEmpty: isEmpty))
  }

  /// `" @ Item"` as a muted suffix on the species line; empty when no item.
  private func itemSuffix(_ item: String?) -> Text {
    guard let item, !item.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return Text("")
    }
    return Text(" @ \(Self.titleizeNonNil(item))")
      .font(Theme.body(.footnote))
      .foregroundStyle(Theme.textSecondary)
  }

  /// The "Ability · Tera Type" secondary line; `nil` when neither is set.
  private func abilityTeraLine(_ member: TeamMember) -> String? {
    var parts: [String] = []
    if let ability = member.ability,
      !ability.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      parts.append(Self.titleizeNonNil(ability))
    }
    if let tera = member.teraType,
      !tera.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    {
      parts.append("Tera \(Self.titleizeNonNil(tera))")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  private func memberAccessibilityLabel(index: Int, member: TeamMember, isEmpty: Bool) -> String {
    if isEmpty {
      return "Slot \(index + 1): empty"
    }
    var label = "Slot \(index + 1): \(Self.titleize(member.species))"
    if let item = member.item, !item.isEmpty {
      label += ", holding \(Self.titleizeNonNil(item))"
    }
    if let detail = abilityTeraLine(member) {
      label += ", \(detail)"
    }
    if !member.moves.isEmpty {
      label += ". Moves: \(member.moves.map(Self.titleizeNonNil).joined(separator: ", "))"
    }
    return label
  }

  // MARK: Warnings (warn-but-allow)

  private func warningsSection(_ warnings: [TeamWarning]) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      Label("Legality", systemImage: "checklist")
        .font(Theme.body(.caption).weight(.semibold))
        .foregroundStyle(Theme.textSecondary)

      ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
        warningRow(warning)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(10)
    .background(
      Theme.warning.opacity(0.10),
      in: RoundedRectangle(cornerRadius: Theme.Radius.md, style: .continuous)
    )
    // role="status" parity — advisory, never an error that gates Apply.
    .accessibilityElement(children: .combine)
  }

  /// One advisory warning: a severity icon **and** the message text — the icon
  /// shape + wording carry the meaning, so the tint is reinforcement (M-AC-UI9.3).
  private func warningRow(_ warning: TeamWarning) -> some View {
    Label {
      Text(warning.message)
        .font(Theme.body(.footnote))
        .foregroundStyle(Theme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: warning.systemImage)
        .imageScale(.small)
        .foregroundStyle(warning.tint)
        .accessibilityHidden(true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(warning.severityLabel): \(warning.message)")
  }

  // MARK: Saved team

  private func savedCard(_ team: SavedTeamRef) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Image(systemName: "checkmark.seal.fill")
          .foregroundStyle(Theme.success)
          .accessibilityHidden(true)
        (Text("Saved to your Teams: ")
          .foregroundStyle(Theme.textSecondary)
          + Text(team.name).fontWeight(.semibold).foregroundStyle(Theme.textPrimary))
          .font(Theme.body(.subheadline))
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 8)
        formatBadge(team.format)
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Saved to your Teams: \(team.name), \(team.format.displayLabel)")

      Button {
        onOpenSavedTeam(team)
      } label: {
        Label("Open in viewer", systemImage: "rectangle.portrait.and.arrow.right")
          .font(Theme.display(.footnote))
      }
      .buttonStyle(.bordered)
      .tint(Theme.accent)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .background(
      Theme.success.opacity(0.10),
      in: RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
    )
    .overlay(
      RoundedRectangle(cornerRadius: Theme.Radius.lg, style: .continuous)
        .strokeBorder(Theme.success.opacity(0.35))
    )
  }

  // MARK: Shared bits

  /// A muted format pill (e.g. "Champions" / "Scarlet/Violet").
  private func formatBadge(_ format: Format) -> some View {
    Text(format.displayLabel)
      .font(Theme.body(.caption2).weight(.semibold))
      .lineLimit(1)
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .foregroundStyle(Theme.textSecondary)
      .background(Theme.surfaceRaised, in: Capsule())
      .accessibilityHidden(true)
  }

  /// Title-cases a slug (`great-tusk` → `Great Tusk`); `nil`/empty ⇒ `—`.
  static func titleize(_ slug: String?) -> String {
    guard let slug, !slug.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return "—"
    }
    return titleizeNonNil(slug)
  }

  /// Title-cases a non-optional slug (`focus-sash` → `Focus Sash`).
  static func titleizeNonNil(_ slug: String) -> String {
    slug
      .split(whereSeparator: { $0 == "-" || $0 == " " || $0 == "_" })
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }
}

// MARK: - Format display label (file-scoped to avoid cross-phase collisions)

private extension Format {
  /// Human-friendly format name for the header badge — mirrors the web
  /// `formatLabel` (`champions` → "Champions", `scarlet-violet` → "Scarlet/Violet").
  var displayLabel: String {
    switch self {
    case .scarletViolet: return "Scarlet/Violet"
    case .champions: return "Champions"
    }
  }
}

// MARK: - Team-warning presentation (file-scoped)

private extension TeamWarning {
  /// A short category word so VoiceOver and the row read the warning's nature in
  /// words, not by color (M-AC-UI9.3).
  var severityLabel: String {
    switch code {
    case .incomplete: return "Note"
    case .evTotalExceeded, .evStatExceeded, .ivOutOfRange: return "Caution"
    case .speciesIllegal, .abilityNotForSpecies, .itemIllegal, .moveNotInLearnset,
      .duplicateSpecies, .duplicateItem:
      return "Legality"
    }
  }

  /// `incomplete` is purely informational; everything else is a validity/legality
  /// caution. The icon SHAPE distinguishes them independently of color.
  var systemImage: String {
    switch code {
    case .incomplete: return "info.circle"
    default: return "exclamationmark.triangle.fill"
    }
  }

  var tint: Color {
    switch code {
    case .incomplete: return Theme.info
    default: return Theme.warning
    }
  }
}

#if DEBUG
private extension StatSpread {
  static let zero = StatSpread(hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0)
}

private func sampleMember(
  species: String?,
  ability: String? = nil,
  item: String? = nil,
  moves: [String] = [],
  tera: String? = nil
) -> TeamMember {
  TeamMember(
    species: species,
    ability: ability,
    item: item,
    moves: moves,
    nature: nil,
    evs: .zero,
    ivs: .zero,
    teraType: tera,
    level: 50,
    nickname: nil,
    gender: nil,
    shiny: nil
  )
}

#Preview("Proposed team + warnings") {
  ScrollView {
    TeamBlocksView(
      proposedTeam: ProposedTeam(
        name: "Sun Offense",
        format: .scarletViolet,
        members: [
          sampleMember(
            species: "great-tusk",
            ability: "protosynthesis",
            item: "booster-energy",
            moves: ["headlong-rush", "close-combat", "ice-spinner", "rapid-spin"],
            tera: "ground"
          ),
          sampleMember(
            species: "flutter-mane",
            ability: "protosynthesis",
            item: "choice-specs",
            moves: ["moonblast", "shadow-ball", "dazzling-gleam"],
            tera: "fairy"
          ),
          sampleMember(species: nil),
        ]
      ),
      proposedTeamWarnings: [
        TeamWarning(
          code: .incomplete,
          message: "This team has 2 of 6 Pokémon — a partial team is fine.",
          slot: nil,
          field: nil
        ),
        TeamWarning(
          code: .moveNotInLearnset,
          message: "Great Tusk can't learn Ice Spinner in this format.",
          slot: 0,
          field: "moves[2]"
        ),
      ],
      savedTeam: nil
    )
    .padding()
  }
}

#Preview("Saved team") {
  TeamBlocksView(
    proposedTeam: nil,
    savedTeam: SavedTeamRef(id: "team-123", name: "Sun Offense", format: .champions)
  )
  .padding()
}

#Preview("Empty (renders nothing)") {
  TeamBlocksView(proposedTeam: nil, savedTeam: nil)
    .padding()
}
#endif
