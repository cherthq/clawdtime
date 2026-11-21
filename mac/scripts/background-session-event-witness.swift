import AppKit
import CoreGraphics
import Foundation

// Read-only, transient local diagnostic. No helper API/config, screenshots,
// window/app titles, input, clipboard, or notification payloads are accessed.
// Run alongside the helper; stdout contains only fixed event names, timestamps
// and coarse availability booleans. This witness does not arm or stop anything.
let arguments = CommandLine.arguments
func option(_ name: String) -> String? {
  guard let index = arguments.firstIndex(of: name), index + 1 < arguments.count else { return nil }
  return arguments[index + 1]
}
guard let pidValue = option("--helper-pid"), let helperPID = Int32(pidValue), helperPID > 0,
  let duration = Double(option("--seconds") ?? "300"), duration >= 1, duration <= 600,
  arguments.count == (option("--seconds") == nil ? 3 : 5)
else {
  fputs("Usage: background-session-event-witness --helper-pid PID [--seconds 1..600]\n", stderr)
  exit(2)
}

struct Availability: Equatable, Codable {
  let sessionAvailable: Bool
  let helperConflict: Bool
  var available: Bool { sessionAvailable && !helperConflict }
}
func availability() -> Availability {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  let active = session?[kCGSessionOnConsoleKey as String] as? Bool == true
    && session?[kCGSessionLoginDoneKey as String] as? Bool == true
    && session?["CGSSessionScreenIsLocked"] as? Bool != true
  let conflict = NSWorkspace.shared.runningApplications.contains {
    !$0.isTerminated && $0.processIdentifier != helperPID
      && ["com.clawdtime.companion", "com.clawdtime.local-control"].contains($0.bundleIdentifier ?? "")
  }
  return Availability(sessionAvailable: active, helperConflict: conflict)
}
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let started = ProcessInfo.processInfo.systemUptime
func emit(_ event: String) {
  let state = availability()
  let record: [String: Any] = [
    "event": event, "timestamp": formatter.string(from: Date()),
    "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
    "available": state.available, "sessionAvailable": state.sessionAvailable,
    "helperConflict": state.helperConflict,
  ]
  if let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
  }
}
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
var observers: [NSObjectProtocol] = []
observers.append(NotificationCenter.default.addObserver(
  forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
) { _ in emit("screen_parameters_changed") })
let workspaceEvents: [(Notification.Name, String)] = [
  (NSWorkspace.willSleepNotification, "workspace_will_sleep"),
  (NSWorkspace.didWakeNotification, "workspace_did_wake"),
  (NSWorkspace.sessionDidResignActiveNotification, "session_resigned_active"),
  (NSWorkspace.sessionDidBecomeActiveNotification, "session_became_active"),
  (NSWorkspace.screensDidSleepNotification, "screens_did_sleep"),
  (NSWorkspace.screensDidWakeNotification, "screens_did_wake"),
]
for (name, event) in workspaceEvents {
  observers.append(NSWorkspace.shared.notificationCenter.addObserver(
    forName: name, object: nil, queue: .main
  ) { _ in emit(event) })
}
for (name, event) in [("com.apple.screenIsLocked", "screen_locked"), ("com.apple.screenIsUnlocked", "screen_unlocked")] {
  observers.append(DistributedNotificationCenter.default().addObserver(
    forName: Notification.Name(name), object: nil, queue: .main
  ) { _ in emit(event) })
}
observers.append(NotificationCenter.default.addObserver(
  forName: Notification.Name("ClawdTimeWitnessDisplayReconfiguration"), object: nil, queue: .main
) { _ in emit("display_reconfiguration") })
let displayCallback: CGDisplayReconfigurationCallBack = { _, _, _ in
  DispatchQueue.main.async {
    NotificationCenter.default.post(name: Notification.Name("ClawdTimeWitnessDisplayReconfiguration"), object: nil)
  }
}
let registration = CGDisplayRegisterReconfigurationCallback(displayCallback, nil)
var previous = availability()
let polling = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { _ in
  let current = availability()
  if current != previous {
    previous = current
    emit("availability_changed")
  }
}
let finish = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { _ in
  emit("witness_finished")
  CGDisplayRemoveReconfigurationCallback(displayCallback, nil)
  exit(0)
}
emit(registration == .success ? "witness_started" : "witness_started_display_callback_unavailable")
app.run()
