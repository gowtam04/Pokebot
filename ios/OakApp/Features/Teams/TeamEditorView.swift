import SwiftUI
import UIKit

/// The full-set team editor (history-and-teams.md M-TEAM-US-1/3; M-UI-US-5): a native
/// `Form` for naming a team and filling each member's complete competitive set —
/// species / ability / item / four moves / nature / EVs / IVs / Tera / level — with
/// pickers, steppers, and search-style text fields so the whole set is editable on a
/// phone (M-AC-T1.3).
///
/// **Warn-but-allow** (M-AC-T3.1 / M-BR-T3): the server's legality/validity warnings are
/// rendered inline (per slot and team-level) but **Save is never disabled** — an EV total
/// over 508, a move outside the learnset, etc. all still save, clearly flagged. Export to
/// Showdown text is offered via the native share sheet (M-AC-T2.3).
struct TeamEditorView: View {
  @State private var model: TeamEditorViewModel
  @State private var exportedPaste: ExportPayload?

  /// When `true`, the editor fetches the full team on appear (existing-team path).
  private let loadsOnAppear: Bool

  init(model: TeamEditorViewModel, loadsOnAppear: Bool = false) {
    _model = State(initialValue: model)
    self.loadsOnAppear = loadsOnAppear
  }

  var body: some View {
    @Bindable var model = model
    Form {
      Section("Team") {
        TextField("Team name", text: $model.name)
          .textInputAutocapitalization(.words)
        LabeledContent("Format", value: formatLabel)
      }

      ForEach($model.members) { $member in
        if let index = model.members.firstIndex(where: { $0.id == member.id }) {
          MemberEditorSection(
            index: index,
            member: $member,
            warnings: model.warnings(forSlot: index),
            onRemove: { model.removeMember(at: index) }
          )
        }
      }

      if model.canAddMember {
        Section {
          Button {
            model.addMember()
          } label: {
            Label("Add Pokémon", systemImage: "plus.circle")
          }
        }
      }

      if !model.teamLevelWarnings.isEmpty {
        Section("Team legality") {
          ForEach(Array(model.teamLevelWarnings.enumerated()), id: \.offset) { _, warning in
            WarningRow(warning: warning)
          }
        }
      }
    }
    .navigationTitle(model.savedTeam == nil ? "New team" : "Edit team")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        if model.isSaving {
          ProgressView()
        } else {
          Button("Save") {
            Task { await model.save() }
          }
          .fontWeight(.semibold)
        }
      }
      if model.teamId != nil {
        ToolbarItem(placement: .topBarLeading) {
          Button {
            Task {
              if let paste = await model.exportPaste() {
                exportedPaste = ExportPayload(text: paste)
              }
            }
          } label: {
            Label("Export", systemImage: "square.and.arrow.up")
          }
        }
      }
    }
    .overlay(alignment: .bottom) {
      if let message = model.errorMessage {
        errorBanner(message)
      }
    }
    .sheet(item: $exportedPaste) { payload in
      ExportSheet(text: payload.text)
    }
    .task {
      if loadsOnAppear { await model.load() }
    }
  }

  // MARK: Details

  private var formatLabel: String {
    switch model.format {
    case .scarletViolet: return "Standard (Scarlet/Violet)"
    case .champions: return "Champions"
    }
  }

  // MARK: Error banner

  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: 8) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(.orange)
      Text(message)
        .font(.footnote)
      Spacer(minLength: 0)
      Button("Dismiss") { model.dismissError() }
        .font(.footnote)
    }
    .padding(12)
    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))
    .padding()
  }
}

// MARK: - Export payload + sheet

/// A small `Identifiable` wrapper so the export paste can drive `.sheet(item:)`.
private struct ExportPayload: Identifiable {
  let id = UUID()
  let text: String
}

/// The export sheet: shows the Showdown paste, a native share affordance (`ShareLink`),
/// and a copy-to-clipboard button (M-AC-T2.3 — native share / clipboard).
private struct ExportSheet: View {
  let text: String
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        Text(text)
          .font(Theme.mono(.footnote))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
          .padding()
      }
      .navigationTitle("Showdown export")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Copy") { UIPasteboard.general.string = text }
        }
        ToolbarItem(placement: .topBarTrailing) {
          ShareLink(item: text) {
            Label("Share", systemImage: "square.and.arrow.up")
          }
        }
        ToolbarItem(placement: .bottomBar) {
          Button("Done") { dismiss() }
        }
      }
    }
  }
}

// MARK: - One member set

/// The editor for a single member slot. A self-contained subview so the parent `Form`
/// stays within the type-checker's reach and each set edits in isolation.
private struct MemberEditorSection: View {
  let index: Int
  @Binding var member: EditableMember
  let warnings: [TeamWarning]
  let onRemove: () -> Void

  var body: some View {
    Section {
      identityFields
      moveFields
      naturePicker
      teraPicker
      Stepper(value: $member.level, in: 1...100) {
        LabeledContent("Level", value: "\(member.level)")
      }
      StatStepperGrid(
        title: "EVs",
        spread: $member.evs,
        range: 0...252,
        step: 4,
        footnote: evFootnote
      )
      StatStepperGrid(
        title: "IVs",
        spread: $member.ivs,
        range: 0...31,
        step: 1
      )
      cosmeticFields

      if !warnings.isEmpty {
        ForEach(Array(warnings.enumerated()), id: \.offset) { _, warning in
          WarningRow(warning: warning)
        }
      }
    } header: {
      HStack {
        Text(headerTitle)
        Spacer()
        Button(role: .destructive, action: onRemove) {
          Label("Remove", systemImage: "trash")
            .labelStyle(.iconOnly)
        }
        .accessibilityLabel("Remove Pokémon \(index + 1)")
      }
    }
  }

  private var headerTitle: String {
    let species = member.species.trimmingCharacters(in: .whitespacesAndNewlines)
    if species.isEmpty { return "Pokémon \(index + 1)" }
    return TeamBlocksView.titleizeNonNil(species)
  }

  @ViewBuilder
  private var identityFields: some View {
    slugField("Species", text: $member.species)
    slugField("Ability", text: $member.ability)
    slugField("Item", text: $member.item)
  }

  @ViewBuilder
  private var moveFields: some View {
    ForEach(0..<4, id: \.self) { moveIndex in
      slugField("Move \(moveIndex + 1)", text: moveBinding(moveIndex))
    }
  }

  /// An explicit per-slot move binding (a `Binding` to an array element is not a stable
  /// keyPath, so it's built by hand over the member binding).
  private func moveBinding(_ index: Int) -> Binding<String> {
    Binding(
      get: { member.moves.indices.contains(index) ? member.moves[index] : "" },
      set: { newValue in
        if member.moves.indices.contains(index) { member.moves[index] = newValue }
      }
    )
  }

  private var naturePicker: some View {
    Picker("Nature", selection: $member.nature) {
      Text("None").tag("")
      ForEach(TeamEditorViewModel.natures, id: \.self) { nature in
        Text(TeamBlocksView.titleizeNonNil(nature)).tag(nature)
      }
    }
  }

  private var teraPicker: some View {
    Picker("Tera type", selection: $member.teraType) {
      Text("None").tag("")
      ForEach(TeamEditorViewModel.teraTypes, id: \.self) { type in
        Text(TeamBlocksView.titleizeNonNil(type)).tag(type)
      }
    }
  }

  @ViewBuilder
  private var cosmeticFields: some View {
    slugField("Nickname", text: $member.nickname, autocapitalize: true)
    Picker("Gender", selection: $member.gender) {
      Text("Unspecified").tag(TeamMember.Gender?.none)
      Text("Male").tag(TeamMember.Gender?.some(.male))
      Text("Female").tag(TeamMember.Gender?.some(.female))
      Text("Genderless").tag(TeamMember.Gender?.some(.neutral))
    }
    Toggle("Shiny", isOn: $member.shiny)
  }

  /// EV-budget footnote — informational, never blocking. Over 508 is the same advisory
  /// the server flags (M-AC-T3.1).
  private var evFootnote: String {
    let total = member.evs.total
    if total > 508 {
      return "Total \(total) / 508 — over the legal budget (saved anyway)."
    }
    return "Total \(total) / 508"
  }

  /// A slug/search text field with no autocapitalization/autocorrection (slugs are
  /// lowercase) unless it's a free-text field like the nickname.
  private func slugField(_ title: String, text: Binding<String>, autocapitalize: Bool = false) -> some View {
    LabeledContent(title) {
      TextField(title, text: text)
        .multilineTextAlignment(.trailing)
        .textInputAutocapitalization(autocapitalize ? .words : .never)
        .autocorrectionDisabled(!autocapitalize)
    }
  }
}

// MARK: - Stat stepper grid

/// Six labeled steppers for an EV or IV spread, with an optional budget footnote. Reused
/// for both spreads; the only difference is the range/step.
private struct StatStepperGrid: View {
  let title: String
  @Binding var spread: EditableStatSpread
  let range: ClosedRange<Int>
  let step: Int
  var footnote: String?

  var body: some View {
    DisclosureGroup(title) {
      statRow("HP", value: $spread.hp)
      statRow("Attack", value: $spread.atk)
      statRow("Defense", value: $spread.def)
      statRow("Sp. Atk", value: $spread.spa)
      statRow("Sp. Def", value: $spread.spd)
      statRow("Speed", value: $spread.spe)
      if let footnote {
        Text(footnote)
          .font(.footnote)
          .foregroundStyle(.secondary)
      }
    }
  }

  private func statRow(_ label: String, value: Binding<Int>) -> some View {
    Stepper(value: value, in: range, step: step) {
      LabeledContent(label) {
        Text("\(value.wrappedValue)")
          .font(Theme.mono(.body))
          .monospacedDigit()
      }
    }
  }
}

// MARK: - Warning row (warn-but-allow advisory)

/// One advisory warning: a severity icon **and** the message text — the icon shape +
/// wording carry the meaning, so any tint is reinforcement only (M-AC-UI9.3).
private struct WarningRow: View {
  let warning: TeamWarning

  var body: some View {
    Label {
      Text(warning.message)
        .font(.footnote)
        .foregroundStyle(Theme.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: isInfo ? "info.circle" : "exclamationmark.triangle.fill")
        .foregroundStyle(isInfo ? Theme.info : Theme.warning)
        .accessibilityHidden(true)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(isInfo ? "Note" : "Caution"): \(warning.message)")
  }

  private var isInfo: Bool { warning.code == .incomplete }
}
