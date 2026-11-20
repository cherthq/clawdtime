import ApplicationServices
import DeviceCore

/// Some applications expose their main/focused window while AXWindows is empty
/// on another Space. These are actual application-owned AX references, not
/// reconstructed CG window IDs. Every consumer still applies its original
/// visibility/geometry/role/semantic guards.
@MainActor enum LocalApplicationWindows {
  static func read(pid: Int32) throws -> [AXUIElement] {
    let app = AXUIElementCreateApplication(pid)
    guard AXUIElementSetMessagingTimeout(app, 0.04) == .success else {
      throw HelperError(409, "Application window witness is unavailable.")
    }
    func attribute(_ name: String) throws -> CFTypeRef? {
      var value: CFTypeRef?
      let status = AXUIElementCopyAttributeValue(app, name as CFString, &value)
      if status == .attributeUnsupported || status == .noValue { return nil }
      guard status == .success else { throw HelperError(409, "Application window witness is unavailable.") }
      return value
    }
    let listed: [AXUIElement]
    if let raw = try attribute("AXWindows") {
      guard CFGetTypeID(raw) == CFArrayGetTypeID(), let values = raw as? [AXUIElement],
        values.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else {
        throw HelperError(409, "Application window witness is invalid.")
      }
      listed = values
    } else { listed = [] }
    func window(_ name: String) throws -> AXUIElement? {
      guard let raw = try attribute(name) else { return nil }
      guard CFGetTypeID(raw) == AXUIElementGetTypeID() else { throw HelperError(409, "Application window witness is invalid.") }
      return (raw as! AXUIElement)
    }
    return try LocalWindowPolicy.windowCandidates(listed: listed, main: window("AXMainWindow"),
      focused: window("AXFocusedWindow"), expectedPID: pid,
      owner: { value in var owner: pid_t = 0; return AXUIElementGetPid(value, &owner) == .success ? owner : nil },
      same: { CFEqual($0, $1) })
  }
}
