import AppKit
import ApplicationServices
import DeviceCore

/// Read-only acceptance probe using the production target-witness implementation.
/// No screenshot, values, titles, paths, input, helper configuration or receipts.
@main struct NativeTargetDiagnostic {
  @MainActor static func main() {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.TextEdit" else {
      print("TextEdit must be frontmost; no inspection performed.")
      exit(2)
    }
    guard AXIsProcessTrusted() else {
      print("Read-only AX diagnostic has no Accessibility access.")
      exit(3)
    }
    var refusals = [String: Int]()
    let snapshot = LocalTargetCapture.capture(displayId: CGMainDisplayID(), diagnostic: { refusals[$0, default: 0] += 1 })
    let roles = Dictionary(grouping: snapshot.targets, by: { $0.point.role }).mapValues(\.count)
    let focused = snapshot.targets.first { $0.point.id == snapshot.focusedId }
    let report: [String: Any] = [
      "targetCount": snapshot.targets.count,
      "roles": roles,
      "focusedTargetAvailable": focused != nil,
      "focusedTargetCanType": focused?.canType ?? false,
      "refusals": refusals,
    ]
    let bytes = try! JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
    print(String(decoding: bytes, as: UTF8.self))
  }
}
