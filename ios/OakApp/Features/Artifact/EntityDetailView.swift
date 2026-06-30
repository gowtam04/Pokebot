import SwiftUI

/// Renders one resolved entity artifact (`ok` arm) as a full, grounded profile — the native
/// mirror of the web entity-detail panes (artifact-viewer.md M-ART-US-1, M-AC-A1.1/A4.2,
/// M-BR-ART-4). One view, five kinds: Pokémon, move, ability, item, and type, each switched on
/// ``EntityArtifactOk/data``.
///
/// Consistent with answers (M-AC-A4.2 — grounded, cited, format-tagged, never an un-sourced data
/// dump): every profile carries the format + generation grounding chrome, an `is_fallback` pill +
/// note when the data is a pre-Gen-9 fallback, and the artifact's `citations`. Type chips use the
/// shared ``TypeBadge`` (color **and** label, never color alone — M-AC-UI9.3) and sprites the
/// shared ``SpriteImage``.
///
/// Drilling deeper (M-ART-US-3 / M-AC-A3.1): the entities **inside** a profile are tappable —
/// a Pokémon's movepool moves and matchup types, a move/type's matchup types, an ability's
/// holders, an item's wild holders — each calling ``onOpen`` to push a new artifact onto the
/// viewer's back stack.
struct EntityDetailView: View {
  let artifact: EntityArtifactOk

  /// Pushes another entity onto the viewer's back stack when one inside this profile is tapped.
  /// Defaults to a no-op so the view renders in isolation / previews.
  var onOpen: (EntityKind, String) -> Void = { _, _ in }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 18) {
        kindBody
        groundingSection
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(16)
    }
  }

  // MARK: Kind dispatch

  @ViewBuilder
  private var kindBody: some View {
    switch artifact.data {
    case .pokemon(let data):
      pokemonBody(data)
    case .move(let data):
      moveBody(data)
    case .ability(let data):
      abilityBody(data)
    case .item(let data):
      itemBody(data)
    case .type(let data):
      typeBody(data)
    }
  }

  // MARK: Pokémon

  @ViewBuilder
  private func pokemonBody(_ data: PokemonArtifactData) -> some View {
    HStack(alignment: .top, spacing: 14) {
      SpriteImage(urlString: data.artworkUrl, name: data.displayName, size: 96)
        .padding(8)
        .background(Theme.azure.opacity(0.06), in: RoundedRectangle(cornerRadius: Theme.Radius.md))
      VStack(alignment: .leading, spacing: 6) {
        Text(data.displayName)
          .font(Theme.display(.title2))
          .foregroundStyle(Theme.textPrimary)
        Text(Self.dexLabel(data.nationalDexNumber))
          .font(Theme.mono(.subheadline))
          .foregroundStyle(Theme.textMuted)
        typeChips(data.types)
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)

    abilitiesSection(data.abilities)
    baseStatsSection(data.baseStats, total: data.baseStatTotal)
    matchupsSection(data.matchups)
    movepoolSection(data.movepool)
  }

  private func abilitiesSection(_ abilities: Abilities) -> some View {
    let rows: [(String, String)] = {
      var out: [(String, String)] = [("Ability", Self.titleize(abilities.slot1))]
      if let slot2 = abilities.slot2, !slot2.isEmpty {
        out.append(("Ability", Self.titleize(slot2)))
      }
      if let hidden = abilities.hidden, !hidden.isEmpty {
        out.append(("Hidden", Self.titleize(hidden)))
      }
      return out
    }()
    return VStack(alignment: .leading, spacing: 6) {
      sectionHeader("Abilities", systemImage: "sparkles")
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        infoRow(label: row.0, value: row.1)
      }
    }
  }

  private func baseStatsSection(_ stats: BaseStats, total: Int) -> some View {
    let rows: [(String, Int)] = [
      ("HP", stats.hp), ("Atk", stats.atk), ("Def", stats.def),
      ("SpA", stats.spa), ("SpD", stats.spd), ("Spe", stats.spe),
    ]
    return VStack(alignment: .leading, spacing: 8) {
      sectionHeader("Base stats", systemImage: "chart.bar")
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        StatBar(label: row.0, value: row.1)
      }
      infoRow(label: "Total", value: String(total))
    }
  }

  @ViewBuilder
  private func matchupsSection(_ matchups: DefensiveProfile) -> some View {
    let quadWeak = Set(matchups.quadWeakTo ?? [])
    let quadResist = Set(matchups.quadResists ?? [])
    if !matchups.weakTo.isEmpty || !matchups.resists.isEmpty || !matchups.immuneTo.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        sectionHeader("Defensive matchups", systemImage: "shield.lefthalf.filled")
        matchupRow("Weak to", matchups.weakTo, marked: quadWeak, mark: "×4")
        matchupRow("Resists", matchups.resists, marked: quadResist, mark: "×¼")
        matchupRow("Immune to", matchups.immuneTo, marked: [], mark: "")
      }
    }
  }

  @ViewBuilder
  private func matchupRow(_ label: String, _ types: [String], marked: Set<String>, mark: String) -> some View {
    if !types.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text(label)
          .font(Theme.body(.caption).weight(.semibold))
          .foregroundStyle(Theme.textSecondary)
        flow {
          ForEach(types, id: \.self) { type in
            tappableType(type, quadMark: marked.contains(type) ? mark : nil)
          }
        }
      }
    }
  }

  @ViewBuilder
  private func movepoolSection(_ groups: [MovepoolGroup]) -> some View {
    if !groups.isEmpty {
      VStack(alignment: .leading, spacing: 10) {
        sectionHeader("Movepool", systemImage: "list.bullet")
        ForEach(Array(groups.enumerated()), id: \.offset) { _, group in
          if !group.moves.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
              Text(Self.titleize(group.method))
                .font(Theme.body(.caption).weight(.semibold))
                .foregroundStyle(Theme.textSecondary)
              ForEach(Array(group.moves.enumerated()), id: \.offset) { _, move in
                Button {
                  onOpen(.move, move.slug)
                } label: {
                  HStack(spacing: 8) {
                    TypeBadge(type: move.type)
                    Text(move.displayName)
                      .font(Theme.body(.subheadline))
                      .foregroundStyle(Theme.textPrimary)
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                      .imageScale(.small)
                      .foregroundStyle(Theme.textMuted)
                  }
                  .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens \(move.displayName)")
              }
            }
          }
        }
      }
    }
  }

  // MARK: Move

  @ViewBuilder
  private func moveBody(_ data: MoveArtifactData) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(data.displayName)
        .font(Theme.display(.title2))
        .foregroundStyle(Theme.textPrimary)
      HStack(spacing: 8) {
        tappableType(data.type, quadMark: nil)
        damageClassBadge(data.damageClass)
      }
      VStack(alignment: .leading, spacing: 6) {
        infoRow(label: "Power", value: data.power.map(String.init) ?? "—")
        infoRow(label: "Accuracy", value: data.accuracy.map { "\($0)%" } ?? "—")
        infoRow(label: "PP", value: data.pp.map(String.init) ?? "—")
        infoRow(label: "Priority", value: Self.signed(data.priority))
        infoRow(label: "Target", value: Self.titleize(data.target))
        if let learners = data.gen9LearnerCount {
          infoRow(label: "Gen 9 learners", value: String(learners))
        }
      }
      effectSection(short: data.effectShort, full: data.effectFull)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Ability

  @ViewBuilder
  private func abilityBody(_ data: AbilityArtifactData) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(data.displayName)
        .font(Theme.display(.title2))
        .foregroundStyle(Theme.textPrimary)
      effectSection(short: data.effectShort, full: data.effectFull)
      if !data.learnedBy.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          sectionHeader("Pokémon with this ability", systemImage: "person.3")
          flow {
            ForEach(Array(data.learnedBy.enumerated()), id: \.offset) { _, holder in
              Button {
                onOpen(.pokemon, holder.slug)
              } label: {
                Text(holder.displayName)
                  .font(Theme.body(.caption).weight(.semibold))
                  .padding(.horizontal, 10)
                  .padding(.vertical, 4)
                  .foregroundStyle(Theme.textPrimary)
                  .background(Theme.surfaceRaised, in: Capsule())
              }
              .buttonStyle(.plain)
              .accessibilityHint("Opens \(holder.displayName)")
            }
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Item

  @ViewBuilder
  private func itemBody(_ data: ItemArtifactData) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Text(data.displayName)
        .font(Theme.display(.title2))
        .foregroundStyle(Theme.textPrimary)
      effectSection(short: data.effectShort, full: data.effectFull)
      if let holders = data.heldByWild, !holders.isEmpty {
        VStack(alignment: .leading, spacing: 6) {
          sectionHeader("Held in the wild", systemImage: "leaf")
          ForEach(Array(holders.enumerated()), id: \.offset) { _, holder in
            infoRow(label: Self.titleize(holder.pokemon), value: Self.percent(holder.rarityPercent))
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Type

  @ViewBuilder
  private func typeBody(_ data: TypeArtifactData) -> some View {
    VStack(alignment: .leading, spacing: 14) {
      flow {
        ForEach(data.types, id: \.self) { type in
          TypeBadge(type: type)
        }
      }
      if let offensive = data.offensive {
        VStack(alignment: .leading, spacing: 10) {
          sectionHeader("Offensive", systemImage: "bolt")
          matchupRow("Super effective", offensive.superEffectiveAgainst, marked: [], mark: "")
          matchupRow("Not very effective", offensive.notVeryEffectiveAgainst, marked: [], mark: "")
          matchupRow("No effect", offensive.noEffectAgainst, marked: [], mark: "")
        }
      }
      VStack(alignment: .leading, spacing: 10) {
        sectionHeader("Defensive", systemImage: "shield.lefthalf.filled")
        matchupRow("Weak to", data.defensive.weakTo, marked: Set(data.defensive.quadWeakTo ?? []), mark: "×4")
        matchupRow("Resists", data.defensive.resists, marked: Set(data.defensive.quadResists ?? []), mark: "×¼")
        matchupRow("Immune to", data.defensive.immuneTo, marked: [], mark: "")
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Grounding chrome (format / generation / fallback / citations)

  private var groundingSection: some View {
    VStack(alignment: .leading, spacing: 8) {
      Divider()
      HStack(spacing: 8) {
        formatBadge(artifact.format)
        Text(artifact.generation)
          .font(Theme.body(.caption))
          .foregroundStyle(Theme.textSecondary)
        Spacer(minLength: 0)
      }
      if artifact.isFallback {
        Label(
          artifact.fallbackNote ?? "Showing fallback data from an earlier generation.",
          systemImage: "clock.arrow.circlepath"
        )
        .font(Theme.body(.caption))
        .foregroundStyle(Theme.warning)
        .fixedSize(horizontal: false, vertical: true)
      }
      if !artifact.citations.isEmpty {
        ForEach(Array(artifact.citations.enumerated()), id: \.offset) { _, citation in
          Label {
            Text("\(citation.source) — \(citation.detail)")
              .font(Theme.body(.caption2))
              .foregroundStyle(Theme.textMuted)
              .fixedSize(horizontal: false, vertical: true)
          } icon: {
            Image(systemName: "doc.text")
              .imageScale(.small)
              .foregroundStyle(Theme.textMuted)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Shared building blocks

  private func sectionHeader(_ title: String, systemImage: String) -> some View {
    Label(title, systemImage: systemImage)
      .font(Theme.display(.subheadline))
      .foregroundStyle(Theme.textPrimary)
  }

  private func infoRow(label: String, value: String) -> some View {
    HStack(alignment: .firstTextBaseline) {
      Text(label)
        .font(Theme.body(.subheadline))
        .foregroundStyle(Theme.textSecondary)
      Spacer(minLength: 12)
      Text(value)
        .font(Theme.body(.subheadline).weight(.semibold))
        .foregroundStyle(Theme.textPrimary)
        .multilineTextAlignment(.trailing)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func effectSection(short: String, full: String) -> some View {
    VStack(alignment: .leading, spacing: 6) {
      if !short.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        MarkdownText(short)
          .font(Theme.body(.body).weight(.medium))
          .foregroundStyle(Theme.textPrimary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
      if !full.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, full != short {
        MarkdownText(full)
          .font(Theme.body(.footnote))
          .foregroundStyle(Theme.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
  }

  private func typeChips(_ types: [String]) -> some View {
    HStack(spacing: 6) {
      ForEach(types, id: \.self) { type in
        tappableType(type, quadMark: nil)
      }
    }
  }

  /// A type chip that opens the type's own artifact when tapped (M-AC-A3.1), with an optional
  /// quad-multiplier mark (`×4` / `×¼`).
  private func tappableType(_ type: String, quadMark: String?) -> some View {
    Button {
      onOpen(.type, type)
    } label: {
      HStack(spacing: 4) {
        TypeBadge(type: type)
        if let quadMark {
          Text(quadMark)
            .font(Theme.body(.caption2).weight(.bold))
            .foregroundStyle(Theme.textSecondary)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityHint("Opens the \(type.capitalized) type")
  }

  private func damageClassBadge(_ damageClass: DamageClass) -> some View {
    Text(damageClass.rawValue.capitalized)
      .font(Theme.body(.caption2).weight(.semibold))
      .padding(.horizontal, 10)
      .padding(.vertical, 3)
      .foregroundStyle(Theme.textSecondary)
      .background(Theme.surfaceRaised, in: Capsule())
  }

  private func formatBadge(_ format: Format) -> some View {
    Text(Self.formatLabel(format))
      .font(Theme.body(.caption2).weight(.semibold))
      .padding(.horizontal, 8)
      .padding(.vertical, 3)
      .foregroundStyle(Theme.textSecondary)
      .background(Theme.surfaceRaised, in: Capsule())
  }

  /// A simple wrapping container for chips. Uses an adaptive grid so chips reflow at large
  /// Dynamic Type without horizontal clipping (no third-party flow-layout — ADR-5).
  private func flow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    LazyVGrid(
      columns: [GridItem(.adaptive(minimum: 64), spacing: 6, alignment: .leading)],
      alignment: .leading,
      spacing: 6
    ) {
      content()
    }
  }

  // MARK: Formatting helpers

  private static func dexLabel(_ number: Int) -> String {
    String(format: "#%04d", number)
  }

  private static func signed(_ value: Int) -> String {
    value > 0 ? "+\(value)" : String(value)
  }

  private static func percent(_ value: Double) -> String {
    value == value.rounded() ? "\(Int(value))%" : "\((value * 10).rounded() / 10)%"
  }

  private static func titleize(_ slug: String) -> String {
    slug
      .split(whereSeparator: { $0 == "-" || $0 == " " || $0 == "_" })
      .map { $0.prefix(1).uppercased() + $0.dropFirst() }
      .joined(separator: " ")
  }

  private static func formatLabel(_ format: Format) -> String {
    switch format {
    case .scarletViolet: return "Scarlet/Violet"
    case .champions: return "Champions"
    }
  }
}

// MARK: - Stat bar

/// One base-stat row: a label, a value, and a proportional bar. The numeric value carries the
/// data; the bar is reinforcement, so meaning never rests on the bar's length/color alone
/// (M-AC-UI9.3). `ProgressView` scales with Dynamic Type and adapts to light/dark.
private struct StatBar: View {
  let label: String
  let value: Int

  /// Bars are normalized against a generous ceiling so even very high base stats (e.g. 255 HP)
  /// stay on-scale.
  private static let ceiling = 255.0

  var body: some View {
    HStack(spacing: 10) {
      Text(label)
        .font(Theme.body(.caption).weight(.semibold))
        .foregroundStyle(Theme.textSecondary)
        .frame(width: 40, alignment: .leading)
      Text(String(value))
        .font(Theme.mono(.caption))
        .monospacedDigit()
        .foregroundStyle(Theme.textPrimary)
        .frame(width: 36, alignment: .trailing)
      ProgressView(value: min(Double(value), Self.ceiling), total: Self.ceiling)
        .tint(Theme.accent)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(label) \(value)")
  }
}

#if DEBUG
/// Decodes a sample `ok` Pokémon artifact for the preview from the same shape the entity
/// endpoint returns. File-scoped so the `#Preview` body stays a plain expression.
private func previewPokemonArtifact() -> EntityArtifactOk? {
  let json = """
    {
      "status": "ok", "kind": "pokemon", "format": "scarlet-violet",
      "resolved": { "slug": "garchomp", "display_name": "Garchomp" },
      "generation": "Gen 9 (Scarlet/Violet)", "is_fallback": false,
      "citations": [{ "source": "pokemon/garchomp", "detail": "Base stats and typing." }],
      "data": {
        "display_name": "Garchomp", "national_dex_number": 445,
        "types": ["dragon", "ground"],
        "abilities": { "slot1": "sand-veil", "hidden": "rough-skin" },
        "base_stats": { "hp": 108, "attack": 130, "defense": 95, "special_attack": 80, "special_defense": 85, "speed": 102 },
        "base_stat_total": 600,
        "sprite_url": "https://example.test/garchomp.png", "artwork_url": "https://example.test/garchomp.png",
        "forms": ["garchomp"], "is_gen9_native": true,
        "matchups": { "weak_to": ["ice", "dragon", "fairy"], "resists": ["rock", "fire", "poison", "electric"], "immune_to": ["electric"], "quad_weak_to": ["ice"], "quad_resists": [] },
        "movepool": [{ "method": "level-up", "moves": [{ "slug": "dragon-claw", "display_name": "Dragon Claw", "type": "dragon" }] }]
      }
    }
    """
  guard
    let artifact = try? JSONDecoder().decode(EntityArtifact.self, from: Data(json.utf8)),
    case let .ok(ok) = artifact
  else {
    return nil
  }
  return ok
}

#Preview("Pokémon profile") {
  if let ok = previewPokemonArtifact() {
    EntityDetailView(artifact: ok)
  } else {
    Text("decode failed")
  }
}
#endif
