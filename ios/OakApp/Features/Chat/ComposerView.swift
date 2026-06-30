import AVFoundation
import PhotosUI
import SwiftUI
import UIKit

/// The chat composer (chat-experience.md M-CHAT-US-1/5/6): a growing text field, a
/// send button, the Champions-mode toggle, the active-team chip, and (P8) image
/// attach via the photo library (`PhotosPicker`) or the camera (``CameraPicker``)
/// with thumbnail/remove UI and permission handling.
///
/// It reads and writes the feature's ``ChatViewModel`` directly (a sibling view in
/// the same feature). All chat/turn logic lives in the view model; this view is
/// layout + bindings plus the local picker presentation state. Dynamic-Type styles
/// and semantic colors adapt to text size and light/dark, and the mode toggle pairs
/// its state with a text label so the current scope is obvious at a glance
/// (M-AC-6.3) without relying on color alone.
struct ComposerView: View {
  let model: ChatViewModel

  @FocusState private var isInputFocused: Bool

  // MARK: Image-attach local state (presentation only; staged images live on the VM)

  /// Selections from the SwiftUI photo-library picker, loaded into `UIImage`s and
  /// staged onto the view model, then cleared.
  @State private var photoSelections: [PhotosPickerItem] = []
  /// Presents the camera (``CameraPicker``) over the composer.
  @State private var isCameraPresented = false
  /// Receives the camera's captured photo, then staged onto the view model.
  @State private var cameraImage: UIImage?
  /// Drives the "camera access is off" alert (M-AC-5.6) when permission is denied.
  @State private var showCameraDeniedAlert = false
  /// A transient inline note, e.g. when the 4-image cap is reached (M-AC-5.2).
  @State private var attachNote: String?

  var body: some View {
    @Bindable var model = model
    VStack(spacing: 8) {
      controlsRow(model: model)

      if let attachNote {
        Text(attachNote)
          .font(Theme.body(.caption))
          .foregroundStyle(Theme.textMuted)
          .frame(maxWidth: .infinity, alignment: .leading)
          .accessibilityLabel(attachNote)
      }

      thumbnailRow(model: model)

      HStack(alignment: .bottom, spacing: 8) {
        TextField("Ask Oak a Pokémon question…", text: $model.composerText, axis: .vertical)
          .font(Theme.body(.body))
          .lineLimit(1...5)
          .textFieldStyle(.plain)
          .focused($isInputFocused)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(Theme.surface, in: RoundedRectangle(cornerRadius: Theme.Radius.lg))

        sendButton
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(.bar)
    .onChange(of: photoSelections) { _, items in
      guard !items.isEmpty else { return }
      Task { @MainActor in await stagePicked(items) }
    }
    .onChange(of: cameraImage) { _, image in
      guard let image else { return }
      let added = model.attachImages([image])
      attachNote = added == 0 ? Self.capReachedNote : nil
      cameraImage = nil
    }
    .fullScreenCover(isPresented: $isCameraPresented) {
      CameraPicker(image: $cameraImage)
        .ignoresSafeArea()
    }
    .alert("Camera access is off", isPresented: $showCameraDeniedAlert) {
      Button("Open Settings") { openSettings() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(
        "Enable camera access in Settings to take a photo. You can still attach images from your photo library."
      )
    }
  }

  // MARK: Derived attach state

  private var remainingSlots: Int {
    max(0, ChatViewModel.maxAttachedImages - model.pendingImages.count)
  }

  /// Whether more images may be attached: under the cap and not mid-stream.
  private var canAttachMore: Bool {
    remainingSlots > 0 && !model.isStreaming
  }

  // MARK: Controls row — mode toggle + active-team chip + image attach

  @ViewBuilder
  private func controlsRow(model: ChatViewModel) -> some View {
    HStack(spacing: 12) {
      // Champions-mode toggle (M-AC-6.1). A labeled toggle, so the current scope is
      // never conveyed by color alone (M-AC-UI9.3 / M-AC-6.3).
      Toggle(isOn: Binding(get: { model.championsMode }, set: { model.setChampionsMode($0) })) {
        Label("Champions", systemImage: "crown")
          .font(Theme.body(.footnote))
          .labelStyle(.titleAndIcon)
      }
      .toggleStyle(.button)
      .buttonStyle(.bordered)
      .tint(model.championsMode ? Theme.sunflower : Theme.textSecondary)
      .disabled(model.isStreaming)
      .accessibilityLabel("Champions mode")
      .accessibilityValue(model.championsMode ? "On" : "Off")

      activeTeamChip(model: model)

      Spacer(minLength: 0)

      attachControls(model: model)
    }
  }

  /// The active-team chip. The team picker is **P10**; for now the chip displays the
  /// selection (or "No team") and offers a clear action when a team is set.
  @ViewBuilder
  private func activeTeamChip(model: ChatViewModel) -> some View {
    if let teamId = model.activeTeamId {
      Button {
        model.setActiveTeam(nil)
      } label: {
        Label("Team \(teamId.prefix(6))", systemImage: "person.3.fill")
          .font(Theme.body(.footnote))
          .labelStyle(.titleAndIcon)
      }
      .buttonStyle(.bordered)
      .tint(Theme.azure)
      .accessibilityLabel("Active team selected. Tap to clear.")
    } else {
      Label("No team", systemImage: "person.3")
        .font(Theme.body(.footnote))
        .labelStyle(.titleAndIcon)
        .foregroundStyle(Theme.textMuted)
        .accessibilityLabel("No active team")
    }
  }

  // MARK: Image attach controls (photo library + camera)

  @ViewBuilder
  private func attachControls(model: ChatViewModel) -> some View {
    // Photo library — the native SwiftUI picker. `maxSelectionCount` is bounded by
    // the remaining slots so the user can't pick past the 4-image cap (M-AC-5.2).
    PhotosPicker(
      selection: $photoSelections,
      maxSelectionCount: max(1, remainingSlots),
      matching: .images,
      photoLibrary: .shared()
    ) {
      Image(systemName: "photo.on.rectangle")
        .font(Theme.body(.title3))
        .symbolRenderingMode(.hierarchical)
    }
    .tint(Theme.accent)
    .disabled(!canAttachMore)
    .accessibilityLabel("Attach photos from library")

    // Camera — only when the device has one (hidden on the Simulator).
    if UIImagePickerController.isSourceTypeAvailable(.camera) {
      Button {
        presentCamera()
      } label: {
        Image(systemName: "camera")
          .font(Theme.body(.title3))
          .symbolRenderingMode(.hierarchical)
      }
      .buttonStyle(.plain)
      .tint(Theme.accent)
      .disabled(!canAttachMore)
      .accessibilityLabel("Take a photo")
    }
  }

  // MARK: Attached-image thumbnails (with per-image remove)

  @ViewBuilder
  private func thumbnailRow(model: ChatViewModel) -> some View {
    if !model.pendingImages.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(Array(model.pendingImages.enumerated()), id: \.offset) { index, image in
            thumbnail(image: image, index: index, total: model.pendingImages.count, model: model)
          }
        }
        .padding(.vertical, 2)
      }
    }
  }

  private func thumbnail(
    image: UIImage,
    index: Int,
    total: Int,
    model: ChatViewModel
  ) -> some View {
    Image(uiImage: image)
      .resizable()
      .scaledToFill()
      .frame(width: 56, height: 56)
      .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.md))
      .overlay(alignment: .topTrailing) {
        Button {
          model.removeImage(at: index)
          attachNote = nil
        } label: {
          Image(systemName: "xmark.circle.fill")
            .symbolRenderingMode(.palette)
            .foregroundStyle(.white, .black.opacity(0.55))
            .font(Theme.body(.body))
            .padding(2)
        }
        .accessibilityLabel("Remove attached image \(index + 1)")
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Attached image \(index + 1) of \(total)")
  }

  // MARK: Send

  @ViewBuilder
  private var sendButton: some View {
    Button {
      isInputFocused = false
      attachNote = nil
      model.send()
    } label: {
      Image(systemName: "arrow.up.circle.fill")
        .font(.system(.title, design: .rounded))
        .symbolRenderingMode(.hierarchical)
    }
    .tint(Theme.accent)
    .disabled(!model.canSend)
    .accessibilityLabel("Send")
  }

  // MARK: Attach actions

  /// Loads picked library items into `UIImage`s and stages them on the view model,
  /// noting when some were dropped because the cap was reached (M-AC-5.2/5.3).
  @MainActor
  private func stagePicked(_ items: [PhotosPickerItem]) async {
    var images: [UIImage] = []
    for item in items {
      if let data = try? await item.loadTransferable(type: Data.self),
        let image = UIImage(data: data)
      {
        images.append(image)
      }
    }
    let added = model.attachImages(images)
    attachNote = added < images.count ? Self.capReachedNote : nil
    photoSelections = []
  }

  /// Presents the camera, requesting permission only on this explicit action
  /// (M-AC-5.6). When access is denied/restricted, surfaces the "enable in Settings"
  /// alert instead of a black capture screen; the library path stays available.
  private func presentCamera() {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized, .notDetermined:
      // `.notDetermined` triggers the system permission prompt on first capture.
      isCameraPresented = true
    case .denied, .restricted:
      showCameraDeniedAlert = true
    @unknown default:
      showCameraDeniedAlert = true
    }
  }

  private func openSettings() {
    if let url = URL(string: UIApplication.openSettingsURLString) {
      UIApplication.shared.open(url)
    }
  }

  private static let capReachedNote =
    "You can attach up to \(ChatViewModel.maxAttachedImages) images."
}

#if DEBUG
#Preview("Composer") {
  VStack {
    Spacer()
    ComposerView(model: ChatViewModel(chat: PreviewChatService(), appState: AppState()))
  }
}
#endif
