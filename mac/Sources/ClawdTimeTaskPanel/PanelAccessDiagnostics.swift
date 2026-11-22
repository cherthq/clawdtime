import ApplicationServices
import Foundation
import TaskPanelCore

/// This path runs before NSApplication, TaskPanelApp or HandsInput construction.
/// The APIs preflight permissions/read settings only: no prompts, taps, capture,
/// network calls, config files, receipt writes or input events.
@MainActor enum PanelAccessDiagnostics {
  static func run() -> Int32 {
    let environment = ProcessInfo.processInfo.environment
    let snapshot = PanelAccessSnapshot(
      accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess(),
      desktopSwitchingEnabled: environment["CLAWDTIME_DESKTOP_SWITCHING"] != "off",
      desktopShortcutsAvailable: HandsInput.configuredDesktopShortcuts(environment: environment) != nil)
    do {
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      var data = try encoder.encode(snapshot); data.append(0x0a)
      FileHandle.standardOutput.write(data)
      return 0
    } catch {
      FileHandle.standardOutput.write(Data("{\"version\":1,\"error\":\"access_check_unavailable\"}\n".utf8))
      return 1
    }
  }
  static func invalidArguments() -> Int32 {
    FileHandle.standardOutput.write(Data("{\"version\":1,\"error\":\"invalid_check_access_arguments\"}\n".utf8))
    return 2
  }
  static func desktop() -> Int32 {
    do {
      let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
      var data = try encoder.encode(HandsDesktop.sourceDiagnostics()); data.append(0x0a)
      FileHandle.standardOutput.write(data)
      return 0
    } catch {
      FileHandle.standardOutput.write(Data("{\"version\":1,\"error\":\"desktop_check_unavailable\"}\n".utf8))
      return 1
    }
  }
  static func invalidDesktopArguments() -> Int32 {
    FileHandle.standardOutput.write(Data("{\"version\":1,\"error\":\"invalid_check_desktop_arguments\"}\n".utf8))
    return 2
  }
}
