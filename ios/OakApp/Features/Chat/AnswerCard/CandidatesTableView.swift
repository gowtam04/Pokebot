import SwiftUI

/// Renders the `candidates` block of an ``OakAnswer`` — the competitive workhorse
/// result set (`candidatesSchema` in `web/src/agent/schemas.ts`) — as a native,
/// horizontally-scrollable table.
///
/// Columns, left to right: **Pokémon** (sprite + name + dex no.) · **Types**
/// (badges) · the six **base stats** (HP/Atk/Def/SpA/SpD/Spe, monospaced and
/// right-aligned) · **Ability**. When the rows carry no `base_stats` — an older
/// `key_stats`-only payload (the schema keeps `base_stats` optional for exactly
/// this reason) — the stat columns fall back to the union of `key_stats` keys.
///
/// The active `sort` column is flagged with a directional caret **and** stronger
/// figures, so color is never the only signal (M-AC-UI9.3 / M-UI-US-9). When the
/// set is `truncated`, a footer states "Showing N of total" (M-AC-1.2 / M-AC-1.4).
/// Columns size to their content and the whole grid scrolls horizontally, so it
/// stays legible and never clips at large Dynamic Type (M-UI-US-1 / M-SUCCESS-3).
///
/// Renders **nothing** when there are no rows to show (field-absent rule).
///
/// Uses the phase-shared `SpriteImage(urlString:name:)` and `TypeBadge(type:)` helpers so
/// sprites and type pills stay consistent across the AnswerCard tree.
struct CandidatesTableView: View {
  let candidates: Candidates

  var body: some View {
    if candidates.shown.isEmpty {
      EmptyView()
    } else {
      VStack(alignment: .leading, spacing: 10) {
        caption
        table
        if candidates.truncated {
          footer
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  // MARK: Caption

  private var caption: some View {
    HStack(spacing: 6) {
      Image(systemName: "tablecells")
        .imageScale(.small)
        .foregroundStyle(Theme.accent)
      Text("Candidates")
        .font(Theme.display(.subheadline))
        .foregroundStyle(Theme.textPrimary)
      if let sortColumnLabel {
        Text("· sorted by \(sortColumnLabel)")
          .font(Theme.body(.caption))
          .foregroundStyle(Theme.textSecondary)
      }
      Spacer(minLength: 0)
    }
  }

  // MARK: Table

  private var table: some View {
    ScrollView(.horizontal, showsIndicators: true) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        headerRow
        separatorRow
        ForEach(Array(candidates.shown.enumerated()), id: \.offset) { index, row in
          dataRow(row, index: index)
        }
      }
    }
    .background(Theme.surface)
    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
    .overlay {
      RoundedRectangle(cornerRadius: Theme.Radius.md)
        .strokeBorder(Theme.separator, lineWidth: 1)
    }
  }

  private var headerRow: some View {
    GridRow {
      cell(background: headerBackground, alignment: .leading) {
        headerLabel("Pokémon")
      }
      cell(background: headerBackground, alignment: .leading) {
        headerLabel("Types")
      }
      ForEach(statColumns) { column in
        cell(background: headerBackground, alignment: .trailing) {
          headerStatLabel(column)
        }
      }
      if showsAbility {
        cell(background: headerBackground, alignment: .leading) {
          headerLabel("Ability")
        }
      }
    }
  }

  /// A full-width hairline under the header (spans every column).
  private var separatorRow: some View {
    GridRow {
      Rectangle()
        .fill(Theme.separator)
        .frame(height: 1)
        .gridCellUnsizedAxes(.horizontal)
        .gridCellColumns(columnCount)
    }
  }

  private func dataRow(_ row: CandidateRow, index: Int) -> some View {
    let background = rowBackground(index)
    return GridRow {
      cell(background: background, alignment: .leading) {
        pokemonCell(row)
      }
      cell(background: background, alignment: .leading) {
        typesCell(row)
      }
      ForEach(statColumns) { column in
        let isSorted = column.id == sortedColumnID
        cell(background: background, alignment: .trailing) {
          Text(column.value(row))
            .font(Theme.mono(.subheadline))
            .fontWeight(isSorted ? .semibold : .regular)
            .monospacedDigit()
            .foregroundStyle(isSorted ? Theme.textPrimary : Theme.textSecondary)
        }
      }
      if showsAbility {
        cell(background: background, alignment: .leading) {
          abilityCell(row)
        }
      }
    }
  }

  // MARK: Cells

  private func pokemonCell(_ row: CandidateRow) -> some View {
    HStack(spacing: 8) {
      SpriteImage(urlString: row.spriteUrl, name: row.name, size: 32)
      VStack(alignment: .leading, spacing: 1) {
        Text(row.name)
          .font(Theme.body(.subheadline))
          .fontWeight(.semibold)
          .foregroundStyle(Theme.textPrimary)
          .fixedSize(horizontal: false, vertical: true)
        if let dexNumber = row.dexNumber {
          Text(dexLabel(dexNumber))
            .font(Theme.mono(.caption2))
            .foregroundStyle(Theme.textSecondary)
        }
      }
    }
  }

  private func typesCell(_ row: CandidateRow) -> some View {
    HStack(spacing: 6) {
      ForEach(row.types, id: \.self) { type in
        TypeBadge(type: type)
      }
    }
  }

  private func abilityCell(_ row: CandidateRow) -> some View {
    let hasAbility = !(row.ability ?? "").isEmpty
    return Text(hasAbility ? row.ability! : "—")
      .font(Theme.body(.subheadline))
      .foregroundStyle(hasAbility ? Theme.textPrimary : Theme.textMuted)
      .fixedSize(horizontal: false, vertical: true)
  }

  // MARK: Header labels

  private func headerLabel(_ text: String) -> some View {
    Text(text)
      .font(Theme.body(.caption2))
      .fontWeight(.semibold)
      .textCase(.uppercase)
      .tracking(0.5)
      .foregroundStyle(Theme.textSecondary)
  }

  private func headerStatLabel(_ column: StatColumn) -> some View {
    let isSorted = column.id == sortedColumnID
    return HStack(spacing: 2) {
      Text(column.label)
      if isSorted {
        // The caret + emphasized weight carry the sort, not color alone.
        Image(systemName: sortAscending ? "chevron.up" : "chevron.down")
          .imageScale(.small)
      }
    }
    .font(Theme.body(.caption2))
    .fontWeight(isSorted ? .bold : .semibold)
    .textCase(.uppercase)
    .tracking(0.5)
    .foregroundStyle(isSorted ? Theme.textPrimary : Theme.textSecondary)
  }

  // MARK: Footer

  private var footer: some View {
    Label(
      "Showing \(candidates.shown.count) of \(candidates.totalCount) — refine to narrow.",
      systemImage: "line.3.horizontal.decrease.circle"
    )
    .font(Theme.body(.caption))
    .foregroundStyle(Theme.textSecondary)
    .labelStyle(.titleAndIcon)
  }

  // MARK: Layout helper

  /// One table cell: consistent padding, fills its grid column (so the row
  /// background reads as one continuous band with `horizontalSpacing: 0`), and
  /// aligns its content.
  @ViewBuilder
  private func cell<Content: View>(
    background: Color,
    alignment: Alignment,
    @ViewBuilder content: () -> Content
  ) -> some View {
    content()
      .padding(.horizontal, 12)
      .padding(.vertical, 8)
      .frame(maxWidth: .infinity, alignment: alignment)
      .background(background)
  }

  // MARK: Columns

  /// The stat columns to render: the fixed six base stats when any row carries
  /// `base_stats`, otherwise the alphabetical union of `key_stats` keys.
  private var statColumns: [StatColumn] {
    if candidates.shown.contains(where: { $0.baseStats != nil }) {
      return [
        StatColumn(id: "hp", label: "HP") { formatStat($0.baseStats?.hp) },
        StatColumn(id: "attack", label: "Atk") { formatStat($0.baseStats?.atk) },
        StatColumn(id: "defense", label: "Def") { formatStat($0.baseStats?.def) },
        StatColumn(id: "special_attack", label: "SpA") { formatStat($0.baseStats?.spa) },
        StatColumn(id: "special_defense", label: "SpD") { formatStat($0.baseStats?.spd) },
        StatColumn(id: "speed", label: "Spe") { formatStat($0.baseStats?.spe) },
      ]
    }

    var keys = Set<String>()
    for row in candidates.shown {
      if let keyStats = row.keyStats {
        keys.formUnion(keyStats.keys)
      }
    }
    return keys.sorted().map { key in
      StatColumn(id: key.lowercased(), label: prettyKey(key)) { row in
        formatScalar(row.keyStats?[key])
      }
    }
  }

  private var showsAbility: Bool {
    candidates.shown.contains { !($0.ability ?? "").isEmpty }
  }

  private var columnCount: Int {
    2 + statColumns.count + (showsAbility ? 1 : 0)
  }

  // MARK: Sort

  /// The id of the stat column the result set is sorted by, if any. The wire
  /// `sort` is a free-form string (e.g. `"speed"`, `"special_defense desc"`); a
  /// column matches when it equals the column key or is that key plus a trailing
  /// direction word — exact matching so `special_defense` never lights up `Def`.
  private var sortedColumnID: String? {
    guard let sort = candidates.sort?.lowercased(), !sort.isEmpty else { return nil }
    return statColumns.first { sort == $0.id || sort.hasPrefix($0.id + " ") }?.id
  }

  private var sortAscending: Bool {
    candidates.sort?.lowercased().contains("asc") == true
  }

  /// A human label for the sorted column, for the caption (falls back to the raw
  /// `sort` string when it doesn't map to a visible column).
  private var sortColumnLabel: String? {
    guard let sort = candidates.sort, !sort.isEmpty else { return nil }
    if let column = statColumns.first(where: { $0.id == sortedColumnID }) {
      return column.label
    }
    return sort
  }

  // MARK: Backgrounds (theme-adaptive washes, legible in light & dark)

  private var headerBackground: Color {
    Theme.textPrimary.opacity(0.06)
  }

  private func rowBackground(_ index: Int) -> Color {
    index.isMultiple(of: 2) ? Color.clear : Theme.textPrimary.opacity(0.04)
  }
}

// MARK: - Supporting column descriptor

/// One stat column: a stable `id` (the lowercased stat key, used for sort
/// matching), a display `label`, and how to read its cell text from a row.
private struct StatColumn: Identifiable {
  let id: String
  let label: String
  let value: (CandidateRow) -> String
}

// MARK: - Formatting (Foundation-free)

private func formatStat(_ value: Int?) -> String {
  value.map(String.init) ?? "—"
}

private func formatScalar(_ value: JSONScalar?) -> String {
  switch value {
  case .some(.string(let string)):
    return string
  case .some(.int(let int)):
    return String(int)
  case .some(.double(let double)):
    if double == double.rounded() {
      return String(Int(double))
    }
    return String((double * 100).rounded() / 100)
  case .some(.bool(let bool)):
    return bool ? "Yes" : "No"
  case .some(.null), .none:
    return "—"
  }
}

/// Zero-padded national dex number, e.g. `6 → "#0006"` (design-system sprite-card
/// dex style).
private func dexLabel(_ number: Int) -> String {
  let digits = String(number)
  let padding = String(repeating: "0", count: max(0, 4 - digits.count))
  return "#" + padding + digits
}

/// Turns a `key_stats` key into a readable header (`"special_attack" → "Special
/// Attack"`) without depending on Foundation.
private func prettyKey(_ key: String) -> String {
  key
    .split(whereSeparator: { $0 == "_" || $0 == " " })
    .map { word in
      guard let first = word.first else { return "" }
      return first.uppercased() + word.dropFirst()
    }
    .joined(separator: " ")
}

#if DEBUG
#Preview("Candidates — base stats, truncated") {
  ScrollView {
    CandidatesTableView(
      candidates: Candidates(
        totalCount: 23,
        truncated: true,
        sort: "speed desc",
        shown: [
          CandidateRow(
            name: "Dragapult",
            dexNumber: 887,
            spriteUrl: "https://example.com/dragapult.png",
            types: ["dragon", "ghost"],
            baseStats: BaseStats(hp: 88, atk: 120, def: 75, spa: 100, spd: 75, spe: 142),
            keyStats: nil,
            ability: "Clear Body"
          ),
          CandidateRow(
            name: "Garchomp",
            dexNumber: 445,
            spriteUrl: "https://example.com/garchomp.png",
            types: ["dragon", "ground"],
            baseStats: BaseStats(hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102),
            keyStats: nil,
            ability: "Rough Skin"
          ),
          CandidateRow(
            name: "Tyranitar",
            dexNumber: 248,
            spriteUrl: "https://example.com/tyranitar.png",
            types: ["rock", "dark"],
            baseStats: BaseStats(hp: 100, atk: 134, def: 110, spa: 95, spd: 100, spe: 61),
            keyStats: nil,
            ability: "Sand Stream"
          ),
        ]
      )
    )
    .padding(16)
  }
}

#Preview("Candidates — key_stats fallback") {
  CandidatesTableView(
    candidates: Candidates(
      totalCount: 2,
      truncated: false,
      sort: nil,
      shown: [
        CandidateRow(
          name: "Iron Bundle",
          dexNumber: 991,
          spriteUrl: nil,
          types: ["ice", "water"],
          baseStats: nil,
          keyStats: ["speed": .int(136), "special_attack": .int(124)],
          ability: "Quark Drive"
        ),
        CandidateRow(
          name: "Flutter Mane",
          dexNumber: 987,
          spriteUrl: nil,
          types: ["ghost", "fairy"],
          baseStats: nil,
          keyStats: ["speed": .int(135), "special_attack": .int(135)],
          ability: nil
        ),
      ]
    )
  )
  .padding(16)
}
#endif
