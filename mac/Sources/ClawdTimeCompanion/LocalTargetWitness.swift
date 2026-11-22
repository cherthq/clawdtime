import AppKit
import ApplicationServices
import CryptoKit
import DeviceCore

private struct WitnessRefusal: Error {
  let site: UInt
  let reason: String?
  let attributeStatus: Int32?
  init(site: UInt = #line, reason: String? = nil, attributeStatus: Int32? = nil) {
    self.site = site; self.reason = reason; self.attributeStatus = attributeStatus
  }
}
private func digest(_ value: String) -> String {
  SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
}

/// No AX strings/values leave this transient snapshot. Only fixed roles and points
/// are exposed; the complete bounded window semantics are compared by digest.
@MainActor struct LocalTargetWitness {
  let point: LocalTargetPoint
  let element: AXUIElement
  let hit: AXUIElement
  let window: AXUIElement
  let process: ProcessLifetimeIdentity
  let windowRect: CGRect
  let elementRect: CGRect
  let windowDigest: String
  let canType: Bool
  let canScroll: Bool
}
@MainActor struct LocalTargetSnapshot {
  var targets: [LocalTargetWitness] = []
  var focusedId: String?
  var windows: [LocalWindowWitness] = []
  func wire() throws -> String {
    struct Wire: Encodable { let targets: [LocalTargetPoint]; let untrusted: Bool }
    let value = try JSONEncoder().encode(Wire(targets: targets.map(\.point), untrusted: true)).base64EncodedString()
    guard value.utf8.count <= 32768 else { throw WitnessRefusal() }
    return value
  }
  func windowWire() throws -> String {
    struct Wire: Encodable { let untrusted = true; let windows: [LocalWindowDescription] }
    let encoded = try JSONEncoder().encode(Wire(windows: windows.map(\.description))).base64EncodedString()
    guard encoded.utf8.count <= 32768 else { throw WitnessRefusal() }
    return encoded
  }
  func activationMatching(_ other: LocalTargetSnapshot, action: LocalPlannedAction) -> LocalWindowWitness? {
    guard action.type == "activate", let targetId = action.targetId,
      let old = windows.first(where: { $0.description.id == targetId }),
      let fresh = other.windows.first(where: { $0.description.id == targetId }), LocalWindowCapture.same(old, fresh) else { return nil }
    return old
  }
  func matching(_ other: LocalTargetSnapshot, action: LocalPlannedAction) -> LocalTargetWitness? {
    let old: LocalTargetWitness?
    if action.type == "type" { old = targets.first { $0.point.id == focusedId && $0.canType } }
    else { old = targets.first { $0.point.matches(action) && (action.type != "scroll" || $0.canScroll) } }
    guard let old, let fresh = other.targets.first(where: { $0.point.id == old.point.id }),
      fresh.point == old.point, fresh.process == old.process, fresh.windowRect == old.windowRect, fresh.elementRect == old.elementRect,
      fresh.windowDigest == old.windowDigest, CFEqual(fresh.element, old.element), CFEqual(fresh.hit, old.hit),
      CFEqual(fresh.window, old.window), action.type != "type" || (other.focusedId == old.point.id && fresh.canType) else { return nil }
    return old
  }
  func intersect(_ other: LocalTargetSnapshot) -> LocalTargetSnapshot {
    let stable = targets.filter { old in other.targets.contains { $0.point == old.point && CFEqual($0.element, old.element) && CFEqual($0.hit, old.hit) } }
    let stableWindows = windows.filter { old in other.windows.contains { LocalWindowCapture.same(old, $0) } }
    return LocalTargetSnapshot(targets: stable, focusedId: focusedId == other.focusedId ? focusedId : nil, windows: stableWindows)
  }
}

@MainActor enum LocalTargetCapture {
  private static let clickable: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXComboBox", "AXMenuButton", "AXDisclosureTriangle"]
  private struct Node { let element: AXUIElement; let role: String; let rect: CGRect; let selectedRange: Bool; let scrolling: Bool; let enabled: Bool }
  private final class Budget {
    let deadline = ProcessInfo.processInfo.systemUptime + 0.30
    var nodes = 0, bytes = 0
    var semanticReferences = [AXUIElement]()
    func check() throws { guard ProcessInfo.processInfo.systemUptime < deadline, nodes <= 384, bytes <= 65536 else { throw WitnessRefusal() } }
    func add(_ value: String) throws { bytes += value.utf8.count; try check() }
  }
  private static func read(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
    var raw: CFTypeRef?
    let status = AXUIElementCopyAttributeValue(element, name as CFString, &raw)
    if status == .noValue { return nil }
    guard status == .success else { throw WitnessRefusal(reason: "attribute_\(name)_status_\(status.rawValue)", attributeStatus: status.rawValue) }
    return raw
  }
  private static func scalar(_ raw: CFTypeRef?) throws -> String {
    guard let raw else { return "nil" }
    if CFGetTypeID(raw) == CFStringGetTypeID() {
      let value = raw as! String
      guard value.utf8.count <= 16384 else { throw WitnessRefusal() }
      return "s:" + value
    }
    if CFGetTypeID(raw) == CFBooleanGetTypeID() { return "b:" + String(CFBooleanGetValue((raw as! CFBoolean))) }
    if CFGetTypeID(raw) == CFNumberGetTypeID() { return "n:" + (raw as! NSNumber).stringValue }
    if CFGetTypeID(raw) == AXValueGetTypeID() {
      let value = raw as! AXValue
      switch AXValueGetType(value) {
      case .cgPoint:
        var v = CGPoint.zero; guard AXValueGetValue(value, .cgPoint, &v), v.x.isFinite, v.y.isFinite else { throw WitnessRefusal() }
        return "p:\(v.x),\(v.y)"
      case .cgSize:
        var v = CGSize.zero; guard AXValueGetValue(value, .cgSize, &v), v.width.isFinite, v.height.isFinite else { throw WitnessRefusal() }
        return "z:\(v.width),\(v.height)"
      case .cfRange:
        var v = CFRange(); guard AXValueGetValue(value, .cfRange, &v), v.location >= 0, v.length >= 0 else { throw WitnessRefusal() }
        return "r:\(v.location),\(v.length)"
      default: throw WitnessRefusal()
      }
    }
    if CFGetTypeID(raw) == CFArrayGetTypeID(), let elements = raw as? [AXUIElement], elements.count <= 128 {
      guard elements.allSatisfy({ CFGetTypeID($0) == AXUIElementGetTypeID() }) else { throw WitnessRefusal() }
      return "refs:" + elements.map { String(CFHash($0)) }.joined(separator: ",")
    }
    throw WitnessRefusal()
  }
  private static func rect(_ element: AXUIElement) throws -> CGRect {
    guard let p = try read(element, "AXPosition"), CFGetTypeID(p) == AXValueGetTypeID(),
      let s = try read(element, "AXSize"), CFGetTypeID(s) == AXValueGetTypeID() else { throw WitnessRefusal() }
    var point = CGPoint.zero, size = CGSize.zero
    guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size),
      point.x.isFinite, point.y.isFinite, size.width.isFinite, size.height.isFinite, size.width >= 0, size.height >= 0 else { throw WitnessRefusal() }
    return CGRect(origin: point, size: size)
  }
  private static func tree(_ element: AXUIElement, bundleId: String, budget: Budget, depth: Int, scrolling: Bool, nodes: inout [Node]) throws -> String {
    try budget.check(); budget.nodes += 1
    guard depth <= 16, AXUIElementSetMessagingTimeout(element, 0.04) == .success else { throw WitnessRefusal() }
    var rawNames: CFArray?
    guard AXUIElementCopyAttributeNames(element, &rawNames) == .success, let names = rawNames as? [String],
      let role = try read(element, "AXRole") as? String, LocalTargetTreePolicy.roles.contains(role) else { throw WitnessRefusal() }
    if names.contains("AXSubrole"), let subrole = try read(element, "AXSubrole") as? String, subrole == "AXSecureTextField" { throw WitnessRefusal() }
    let frame = try rect(element)
    var semantic = [String]()
    let attributes = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXIdentifier", "AXValue", "AXEnabled", "AXSelected", "AXExpanded", "AXFocused", "AXMain", "AXMinimized", "AXFullScreen", "AXPosition", "AXSize", "AXSelectedTextRange", "AXNumberOfCharacters", "AXSelectedChildren"]
    var selectedRange = false, enabled = true, hasStringValue = false
    for name in attributes {
      try budget.check()
      let raw: CFTypeRef?
      var unavailableDescription = false
      do { raw = names.contains(name) ? try read(element, name) : nil }
      catch {
        guard let status = (error as? WitnessRefusal)?.attributeStatus,
          LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: bundleId, role: role, attribute: name, status: status) else { throw error }
        raw = nil; unavailableDescription = true
      }
      if name == "AXValue", let raw, CFGetTypeID(raw) == CFStringGetTypeID() { hasStringValue = true }
      if name == "AXSelectedChildren", let raw {
        guard CFGetTypeID(raw) == CFArrayGetTypeID(), let selected = raw as? [AXUIElement], selected.count <= 128 else { throw WitnessRefusal() }
        budget.semanticReferences.append(contentsOf: selected)
      }
      let value: String
      if let raw, CFGetTypeID(raw) == AXUIElementGetTypeID() {
        guard LocalTargetTreePolicy.allowsElementValue(role: role, attribute: name) else { throw WitnessRefusal() }
        let reference = raw as! AXUIElement
        budget.semanticReferences.append(reference)
        value = "ref:" + String(CFHash(reference))
      } else { value = unavailableDescription ? "unavailable:AXDescription:failure" : try scalar(raw) }
      if name == "AXSelectedTextRange", let raw, CFGetTypeID(raw) == AXValueGetTypeID(), AXValueGetType(raw as! AXValue) == .cfRange { selectedRange = true }
      if name == "AXEnabled", let number = raw as? NSNumber { enabled = number.boolValue }
      let entry = name + ":" + String(value.utf8.count) + ":" + value
      try budget.add(entry); semantic.append(entry)
    }
    if ["AXTextField", "AXTextArea", "AXComboBox"].contains(role), !hasStringValue { throw WitnessRefusal() }
    var actions: CFArray?
    guard AXUIElementCopyActionNames(element, &actions) == .success, let actionNames = actions as? [String], actionNames.count <= 32 else { throw WitnessRefusal() }
    semantic.append("actions:" + actionNames.sorted().joined(separator: "|"))
    let inScroll = scrolling || role == "AXScrollArea"
    nodes.append(Node(element: element, role: role, rect: frame, selectedRange: selectedRange, scrolling: inScroll, enabled: enabled))
    if names.contains("AXChildren"), let raw = try read(element, "AXChildren") {
      guard CFGetTypeID(raw) == CFArrayGetTypeID(), let children = raw as? [AXUIElement], children.count <= 128 else { throw WitnessRefusal() }
      for child in children { semantic.append(try tree(child, bundleId: bundleId, budget: budget, depth: depth + 1, scrolling: inScroll, nodes: &nodes)) }
    }
    return "(" + semantic.joined(separator: "\u{1f}") + ")"
  }
  private static func process(_ pid: pid_t) -> ProcessLifetimeIdentity? {
    guard let app = NSRunningApplication(processIdentifier: pid), let bundle = app.bundleIdentifier,
      !LocalInputExclusion.isOwned(bundleId: bundle, pid: pid, helperPID: ProcessInfo.processInfo.processIdentifier) else { return nil }
    return ProcessLifetimeIdentity.resolveLive(pid: pid, bundleId: bundle, launchTime: app.launchDate?.timeIntervalSince1970)
  }
  private static func hit(_ point: CGPoint) -> AXUIElement? {
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(point.x), Float(point.y), &element) == .success else { return nil }
    return element
  }
  private static func point(_ rect: CGRect, display: CGRect) -> (Double, Double, CGPoint) {
    let x = ((rect.midX - display.minX) / max(1, display.width - 1) * 1_000_000).rounded() / 1_000_000
    let y = ((rect.midY - display.minY) / max(1, display.height - 1) * 1_000_000).rounded() / 1_000_000
    return (x, y, CGPoint(x: display.minX + x * max(1, display.width - 1), y: display.minY + y * max(1, display.height - 1)))
  }
  static func capture(displayId: UInt32, diagnostic: ((String) -> Void)? = nil) -> LocalTargetSnapshot {
    let display = CGDisplayBounds(displayId), budget = Budget()
    guard AXIsProcessTrusted(), let rows = CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] else { return LocalTargetSnapshot() }
    var result = LocalTargetSnapshot(), visited = Set<String>()
    let focus = LocalFocusWitness.current()
    for row in rows {
      if result.targets.count >= 32 || visited.count >= 8 || ProcessInfo.processInfo.systemUptime >= budget.deadline { break }
      guard (row[kCGWindowLayer as String] as? Int) == 0,
        let pid = (row[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, let identity = process(pid),
        let bounds = row[kCGWindowBounds as String] as? [String: Any], let cgRect = CGRect(dictionaryRepresentation: bounds as CFDictionary),
        display.contains(cgRect), cgRect.width > 1, cgRect.height > 1 else { continue }
      let key = identity.stableMaterial + String(describing: cgRect)
      guard visited.insert(key).inserted else { continue }
      do {
        let raw = try LocalApplicationWindows.read(pid: pid)
        let windows = raw.filter { (try? rect($0)) == cgRect }
        guard windows.count == 1 else { diagnostic?("window_geometry_unmatched"); continue }
        let window = windows[0]
        budget.semanticReferences.removeAll()
        var nodes = [Node]()
        let semantic = digest(try tree(window, bundleId: identity.bundleId, budget: budget, depth: 0, scrolling: false, nodes: &nodes))
        try budget.check()
        guard LocalTargetTreePolicy.referencesContained(budget.semanticReferences, in: nodes.map(\.element), same: { CFEqual($0, $1) }) else { diagnostic?("reference_outside_window"); continue }
        // A standard native titlebar is offered only with a close-button chrome
        // witness and an actual Window AX hit, never an arbitrary top-strip click.
        if (try? read(window, "AXSubrole") as? String) == "AXStandardWindow",
          let close = try? read(window, "AXCloseButton"), CFGetTypeID(close) == AXUIElementGetTypeID(),
          let closeRect = try? rect(close as! AXUIElement), closeRect.minY >= cgRect.minY,
          closeRect.maxY <= cgRect.minY + 40, closeRect.height > 1 {
          let titleRect = CGRect(x: cgRect.minX, y: closeRect.minY, width: cgRect.width, height: closeRect.height)
          let (x, y, coordinate) = point(titleRect, display: display)
          if let titleHit = hit(coordinate), CFEqual(titleHit, window) {
            let id = digest(identity.stableMaterial + "|title|" + String(CFHash(window)) + "|" + semantic)
            result.targets.append(LocalTargetWitness(point: .init(id: id, role: "AXWindow", x: x, y: y), element: window, hit: titleHit,
              window: window, process: identity, windowRect: cgRect, elementRect: cgRect, windowDigest: semantic, canType: false, canScroll: false))
          }
        }
        for node in nodes where clickable.contains(node.role) && node.enabled && node.rect.width > 1 && node.rect.height > 1 && display.contains(node.rect) {
          if result.targets.count >= 32 { break }
          let (x, y, coordinate) = point(node.rect, display: display)
          guard (0...1).contains(x), (0...1).contains(y), cgRect.contains(coordinate),
            let hit = hit(coordinate), CFEqual(hit, node.element) else { continue }
          let id = digest(identity.stableMaterial + "|" + String(CFHash(window)) + "|" + String(CFHash(node.element)) + "|" + semantic)
          let target = LocalTargetWitness(point: .init(id: id, role: node.role, x: x, y: y), element: node.element, hit: hit,
            window: window, process: identity, windowRect: cgRect, elementRect: node.rect, windowDigest: semantic,
            canType: ["AXTextField", "AXTextArea", "AXComboBox"].contains(node.role) && node.selectedRange,
            canScroll: node.scrolling)
          result.targets.append(target)
          if let focus, focus.process == identity, CFEqual(focus.element, node.element) { result.focusedId = id }
        }
      } catch {
        // Only an explicit read-only diagnostic receives fixed refusal codes;
        // never emit AX values, labels, window titles or other screen content.
        diagnostic?(identity.bundleId + ":" + ((error as? WitnessRefusal).map { $0.reason ?? "witness_site_\($0.site)" } ?? "window_witness_unavailable"))
        continue
      } // Unsupported/incomplete windows provide no target proof.
    }
    return result
  }
  static func validate(_ target: LocalTargetWitness, action: LocalPlannedAction, displayId: UInt32) -> Bool {
    guard process(target.process.pid) == target.process else { return false }
    let fresh = capture(displayId: displayId)
    guard let current = fresh.targets.first(where: { $0.point.id == target.point.id }),
      current.point == target.point, CFEqual(current.window, target.window), CFEqual(current.element, target.element), CFEqual(current.hit, target.hit),
      current.windowRect == target.windowRect, current.elementRect == target.elementRect,
      current.windowDigest == target.windowDigest else { return false }
    return action.type != "type" || (current.canType && fresh.focusedId == target.point.id)
  }
}
