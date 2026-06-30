import SwiftUI
import UIKit

/// A thin SwiftUI wrapper over `UIImagePickerController` in **camera** mode
/// (chat-experience.md M-CHAT-US-5 / M-AC-5.1). This is the one deliberate UIKit use
/// in the app (conventions.md): SwiftUI has no native camera-capture control, so the
/// composer presents this representable to take a photo. Library selection uses the
/// native SwiftUI `PhotosPicker` instead, so it does not need a wrapper.
///
/// Result is delivered through the `image` binding (set to the captured photo, or
/// left unchanged on cancel); the picker dismisses itself for both outcomes via the
/// environment's `dismiss` action, so the presenter only owns the `isPresented`
/// flag and reacts to the binding.
struct CameraPicker: UIViewControllerRepresentable {
  /// Receives the captured image. Left untouched when the user cancels.
  @Binding var image: UIImage?

  @Environment(\.dismiss) private var dismiss

  func makeUIViewController(context: Context) -> UIImagePickerController {
    let picker = UIImagePickerController()
    picker.sourceType = .camera
    picker.allowsEditing = false
    picker.delegate = context.coordinator
    return picker
  }

  func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  /// Bridges the UIKit picker delegate callbacks (delivered on the main actor) back
  /// into the SwiftUI binding. `@MainActor` so it satisfies the main-actor-isolated
  /// `UIImagePickerControllerDelegate` requirements directly.
  @MainActor
  final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
    private let parent: CameraPicker

    init(_ parent: CameraPicker) {
      self.parent = parent
    }

    func imagePickerController(
      _ picker: UIImagePickerController,
      didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
    ) {
      if let captured = info[.originalImage] as? UIImage {
        parent.image = captured
      }
      parent.dismiss()
    }

    func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
      parent.dismiss()
    }
  }
}
