import Foundation
import ServiceManagement

/// Open at login. It is off until the person turns it on.
public protocol LoginItemControlling: AnyObject {
  var isEnabled: Bool { get }
  /// macOS asks the person to allow it in System Settings.
  var needsApproval: Bool { get }
  func setEnabled(_ enabled: Bool) throws
}

/// The app itself as a login item, through SMAppService.
public final class AppLoginItem: LoginItemControlling {
  public init() {}
  public var isEnabled: Bool { SMAppService.mainApp.status == .enabled }
  public var needsApproval: Bool { SMAppService.mainApp.status == .requiresApproval }
  public func setEnabled(_ enabled: Bool) throws {
    if enabled {
      guard SMAppService.mainApp.status != .enabled else { return }
      try SMAppService.mainApp.register()
    } else {
      guard SMAppService.mainApp.status == .enabled || SMAppService.mainApp.status == .requiresApproval else { return }
      try SMAppService.mainApp.unregister()
    }
  }
  public static func openLoginItemsSettings() { SMAppService.openSystemSettingsLoginItems() }
}
