import AppKit
import notify
import TaskPanelCore

/// Reads the panel's preferences again when the runtime says that Settings
/// changed them (`PanelPreferences.notice`): the look and the size of the
/// mascot, and the voice. So a change in Settings shows at once, with no
/// restart. The preferences are the panel's own: the runtime writes them with
/// `defaults`, and this process reads them from the same domain.
@MainActor final class SettingsReload {
  private var token: Int32 = NOTIFY_TOKEN_INVALID
  private let defaults: UserDefaults

  init(defaults: UserDefaults = .standard) { self.defaults = defaults }

  /// Starts to listen. `apply` runs on the main queue after each notice.
  func start(_ apply: @escaping @MainActor (UserDefaults) -> Void) {
    guard token == NOTIFY_TOKEN_INVALID else { return }
    let defaults = defaults
    notify_register_dispatch(PanelPreferences.notice, &token, .main) { _ in
      MainActor.assumeIsolated { apply(defaults) }
    }
  }
}

extension PetController {
  /// The look and the size from the preferences, as Settings left them.
  func reloadLook(from defaults: UserDefaults) {
    let style = MascotStyle(rawValue: defaults.string(forKey: "pet.style") ?? "") ?? .flint
    if style != self.style { self.style = style }
    let eye = defaults.bool(forKey: "pet.flintEye")
    if eye != flintEye { flintEye = eye }
    let size = PetLayout.scale(defaults.object(forKey: "pet.size") as? Double ?? PetLayout.defaultScale)
    if abs(size - scale) > 0.001 { scale = size }
  }
}
