import AppKit
import DeviceCore

// Synthetic/offscreen only: never constructs DeviceApp, reads configuration or opens a listener.
let output = CommandLine.arguments.dropFirst().first ?? "/tmp/clawdtime-panel-preview"
try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
_ = NSApplication.shared
NSApp.setActivationPolicy(.prohibited)
let scenarios = ["working", "approval", "uncertain", "completed", "unverified", "stale", "ended", "pending", "unicode", "large"]
for scenario in scenarios {
  for expanded in [false, true] {
    for dark in [false, true] {
      let width: CGFloat = scenario == "unicode" ? 360 : 480
      let height: CGFloat = (expanded ? 480 : 270) + (scenario == "large" ? 80 : 0)
      let view = ActivityPanelView(frame: NSRect(x:0,y:0,width:width,height:height))
      view.expanded = expanded
      if scenario == "large" { view.scaleText(1.35) }
      view.appearance = NSAppearance(named:dark ? .darkAqua : .aqua)
      var body: [String: Any] = ["sessionId":"fixture-session","callId":"fixture-call","memberId":"fixture-member","displayId":7,
        "expiresAt":Date().addingTimeInterval(5).timeIntervalSinceReferenceDate,"agent":"codex",
        "projectLabel":scenario == "unicode" ? String(repeating:"確認 café 🌿 ",count:10) : "Demo project · Chat 12ab34",
        "callState":scenario == "ended" ? "ended" : "connected","executionState":scenario == "uncertain" ? "uncertain" : "working",
        "executor":"native","executorEpoch":3,"policyRevision":1,"presentationVersion":1]
      let work = scenario == "approval" ? "pending_approval" : ["completed","unverified"].contains(scenario) ? "completed" : scenario == "uncertain" ? "uncertain" : "executing"
      var activity: [String:Any] = ["version":1,"sequence":5,"delivery":"acknowledged","work":work,
        "currentSummary":"Confirmed the synthetic fixture result. Café 確認 👩‍💻 ✅",
        "entries":[["activityId":"fixture-1","sequence":4,"kind":"status","summary":"Checking the selected group"],
          ["activityId":"fixture-2","sequence":5,"kind":"status","summary":"Confirmed the synthetic fixture result. Café 確認 ✅"]]]
      if ["completed","unverified","uncertain"].contains(scenario) {
        activity["outcome"] = ["outcomeId":"outcome-1","status":work,"verification":scenario == "uncertain" ? "unknown" : scenario == "unverified" ? "not_verified" : "agent_observed","summary":"Synthetic result reported; no real input performed."]
      }
      body["activity"] = activity
      let telemetry = try JSONDecoder().decode(PanelTelemetry.self,from:JSONSerialization.data(withJSONObject:body))
      let pending: PanelCommand? = scenario == "pending" ? try JSONDecoder().decode(PanelCommand.self,from:Data("{\"id\":\"command-1\",\"sessionId\":\"fixture-session\",\"callId\":\"fixture-call\",\"type\":\"pause\"}".utf8)) : nil
      view.update(PanelPresentation(telemetry:scenario == "stale" ? nil : telemetry,pending:pending,sharing:scenario == "stale" ? "Stopped locally" : "Viewing synthetic Mac"))
      let window = NSWindow(contentRect:view.frame,styleMask:[.borderless],backing:.buffered,defer:false)
      window.appearance = view.appearance
      window.contentView = view // Never ordered onscreen.
      view.layoutSubtreeIfNeeded()
      precondition(view.stop.isEnabled, "Local Stop must always be enabled")
      for button in [view.stop, view.mute, view.pause, view.end, view.details, view.setup] {
        precondition(view.bounds.contains(button.convert(button.bounds, to: view)), "Clipped control: \(button.title)")
      }
      if ["stale", "ended", "pending"].contains(scenario) { precondition(!view.end.isEnabled && !view.mute.isEnabled && !view.pause.isEnabled) }
      let bitmap = view.bitmapImageRepForCachingDisplay(in:view.bounds)!
      view.effectiveAppearance.performAsCurrentDrawingAppearance {
        view.cacheDisplay(in:view.bounds,to:bitmap)
      }
      let data = bitmap.representation(using:.png,properties:[:])!
      let name = "\(scenario)-\(expanded ? "expanded" : "compact")-\(dark ? "dark" : "light").png"
      try data.write(to:URL(fileURLWithPath:output).appendingPathComponent(name))
    }
  }
}
print("Rendered \(scenarios.count * 4) synthetic panel images to \(output). No helper configuration, capture, native input or network used.")
