// Local qualification only: one disposable app, two bounded synthetic windows.
// No input, file/network access, audio, capture or permission requests.
import AppKit

final class CaptureFixture: NSObject, NSApplicationDelegate {
  var windows: [NSWindow] = []
  var labels: [NSTextField] = []
  var ticks = 0
  var timer: Timer?
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.accessory)
    guard let screen = NSScreen.screens.first(where: {
      ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == CGMainDisplayID()
    }) else { NSApp.terminate(nil); return }
    let visible = screen.visibleFrame
    let width = min(500, (visible.width - 80) / 2)
    let height = min(360, visible.height - 160)
    guard width >= 100, height >= 100 else { NSApp.terminate(nil); return }
    for (index, name) in ["Alpha", "Beta"].enumerated() {
      let window = NSWindow(contentRect: NSRect(x: visible.minX + 20 + Double(index) * (width + 20),
        y: visible.minY + 40, width: width, height: height), styleMask: [.titled, .closable],
        backing: .buffered, defer: false)
      window.title = "ClawdTime Capture Fixture " + name
      window.isReleasedWhenClosed = false
      window.collectionBehavior = [.canJoinAllSpaces, .canJoinAllApplications, .stationary, .fullScreenAuxiliary]
      let label = NSTextField(wrappingLabelWithString: "Synthetic " + name)
      label.frame = NSRect(x: 20, y: 20, width: width - 40, height: height - 40)
      label.font = .systemFont(ofSize: 28)
      window.contentView?.addSubview(label)
      window.orderFront(nil)
      windows.append(window); labels.append(label)
    }
    NSApp.activate(ignoringOtherApps: true)
    timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
      guard let self else { return }
      self.ticks += 1
      for (index, label) in self.labels.enumerated() {
        label.stringValue = "Synthetic view \(index + 1)\nFrame tick \(self.ticks)\nLocal capture only"
      }
    }
  }
}
let fixture = CaptureFixture()
NSApplication.shared.delegate = fixture
NSApplication.shared.run()
