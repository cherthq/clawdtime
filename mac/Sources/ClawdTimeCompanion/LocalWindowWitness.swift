import AppKit
import ApplicationServices
import CryptoKit
import DeviceCore

struct LocalWindowDescription: Encodable, Equatable {
  let id: String
  let app: String
  let title: String
}
@MainActor struct LocalWindowWitness {
  let description: LocalWindowDescription
  let process: ProcessLifetimeIdentity
  let window: AXUIElement
  let bounds: CGRect
  let documentDigest: String
}
private struct WindowRefusal: Error {}

@MainActor enum LocalWindowCapture {
  private static func hash(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }
  private static func read(_ element: AXUIElement, _ attribute: String, optional: Bool = false) throws -> CFTypeRef? {
    var value: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
    if optional && (status == .attributeUnsupported || status == .noValue) { return nil }
    guard status == .success else { throw WindowRefusal() }
    return value
  }
  private static func bounded(_ raw: CFTypeRef?, max: Int, optional: Bool = false) throws -> String {
    guard let raw else { if optional { return "" }; throw WindowRefusal() }
    let value: String
    if CFGetTypeID(raw) == CFStringGetTypeID() { value = raw as! String }
    else if CFGetTypeID(raw) == CFURLGetTypeID() { value = (raw as! URL).absoluteString }
    else { throw WindowRefusal() }
    guard value.utf8.count <= max, optional || !value.isEmpty,
      !value.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw WindowRefusal() }
    return value
  }
  private static func identity(_ app: NSRunningApplication, applications: [String]) -> ProcessLifetimeIdentity? {
    guard !app.isTerminated, !app.isHidden, let bundle = app.bundleIdentifier, bundle.utf8.count <= 80,
      LocalWindowPolicy.allowed(bundle, applications: applications),
      !LocalInputExclusion.isOwned(bundleId: bundle, pid: app.processIdentifier, helperPID: ProcessInfo.processInfo.processIdentifier) else { return nil }
    return ProcessLifetimeIdentity.resolve(pid: app.processIdentifier, bundleId: bundle, launchTime: app.launchDate?.timeIntervalSince1970)
  }
  private static func inspect(_ window: AXUIElement, app: NSRunningApplication, applications: [String], display: CGRect) throws -> LocalWindowWitness {
    guard AXUIElementSetMessagingTimeout(window, 0.04) == .success,
      let identity = identity(app, applications: applications),
      (try read(window, "AXRole") as? String) == "AXWindow",
      (try read(window, "AXSubrole") as? String) == "AXStandardWindow",
      (try read(window, "AXMinimized") as? NSNumber)?.boolValue == false,
      let rawPosition = try read(window, "AXPosition"), CFGetTypeID(rawPosition) == AXValueGetTypeID(),
      let rawSize = try read(window, "AXSize"), CFGetTypeID(rawSize) == AXValueGetTypeID() else { throw WindowRefusal() }
    var position = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(rawPosition as! AXValue, .cgPoint, &position), AXValueGetValue(rawSize as! AXValue, .cgSize, &size),
      position.x.isFinite, position.y.isFinite, size.width.isFinite, size.height.isFinite,
      size.width > 1, size.height > 1 else { throw WindowRefusal() }
    let rect = CGRect(origin: position, size: size)
    guard display.contains(rect) else { throw WindowRefusal() }
    let title = try bounded(read(window, "AXTitle"), max: 160)
    let document = try bounded(read(window, "AXDocument", optional: true), max: 4096, optional: true)
    let identifier = try bounded(read(window, "AXIdentifier", optional: true), max: 256, optional: true)
    var rawActions: CFArray?
    guard AXUIElementCopyActionNames(window, &rawActions) == .success,
      let actions = rawActions as? [String], actions.contains(kAXRaiseAction as String) else { throw WindowRefusal() }
    let documentDigest = hash(String(document.utf8.count) + ":" + document + "|" + identifier)
    let id = hash(identity.stableMaterial + "|" + String(CFHash(window)) + "|" + title + "|" + documentDigest + "|" + String(describing: rect))
    // App display text is a fixed identity, not arbitrary runtime-generated prose.
    return LocalWindowWitness(description: .init(id: id, app: identity.bundleId, title: title), process: identity,
      window: window, bounds: rect, documentDigest: documentDigest)
  }
  static func capture(displayId: UInt32, applications: [String]) -> [LocalWindowWitness] {
    guard !applications.isEmpty, LocalWindowPolicy.validApplications(applications), AXIsProcessTrusted() else { return [] }
    let deadline = ProcessInfo.processInfo.systemUptime + 0.25, display = CGDisplayBounds(displayId)
    var result = [LocalWindowWitness]()
    for app in NSWorkspace.shared.runningApplications where identity(app, applications: applications) != nil {
      if result.count >= 20 || ProcessInfo.processInfo.systemUptime >= deadline { break }
      let element = AXUIElementCreateApplication(app.processIdentifier)
      guard AXUIElementSetMessagingTimeout(element, 0.04) == .success,
        let raw = try? read(element, "AXWindows"), let windows = raw as? [AXUIElement], windows.count <= 32 else { continue }
      for window in windows {
        if result.count >= 20 || ProcessInfo.processInfo.systemUptime >= deadline { break }
        if let witness = try? inspect(window, app: app, applications: applications, display: display) { result.append(witness) }
      }
    }
    return result
  }
  static func same(_ old: LocalWindowWitness, _ fresh: LocalWindowWitness) -> Bool {
    old.description == fresh.description && old.process == fresh.process && old.bounds == fresh.bounds &&
      old.documentDigest == fresh.documentDigest && CFEqual(old.window, fresh.window)
  }
  static func validate(_ witness: LocalWindowWitness, displayId: UInt32, applications: [String]) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: witness.process.pid),
      identity(app, applications: applications) == witness.process else { return false }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    guard AXUIElementSetMessagingTimeout(element, 0.04) == .success,
      let raw = try? read(element, "AXWindows"), let windows = raw as? [AXUIElement], windows.count <= 32,
      windows.contains(where: { CFEqual($0, witness.window) }),
      let current = try? inspect(witness.window, app: app, applications: applications, display: CGDisplayBounds(displayId)) else { return false }
    return same(witness, current)
  }
  /// Only after receipt reservation and final validation. Either operation may
  /// affect the desktop; failure after entering this method is uncertain.
  static func activate(_ witness: LocalWindowWitness) throws {
    guard let app = NSRunningApplication(processIdentifier: witness.process.pid),
      identity(app, applications: [witness.process.bundleId]) == witness.process,
      AXUIElementPerformAction(witness.window, kAXRaiseAction as CFString) == .success,
      app.activate(options: []) else {
      throw HelperError(503, "Window activation outcome is unconfirmed.")
    }
  }
}
