import AppKit
import ApplicationServices
import ScreenCaptureKit
import TaskPanelCore

/// The main display, as the contract counts it: points from its top left corner.
struct HandsDisplay {
  let id: CGDirectDisplayID
  let map: ScreenMap
  static var main: HandsDisplay? {
    let id = CGMainDisplayID()
    let bounds = CGDisplayBounds(id)
    var scale = 1.0
    if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 { scale = Double(mode.pixelWidth) / Double(mode.width) }
    guard let map = ScreenMap(width: Double(bounds.width), height: Double(bounds.height), scale: scale) else { return nil }
    return HandsDisplay(id: id, map: map)
  }
}

/// The seeing half of the hands: one picture of the main display, and the
/// elements of the front window from the Accessibility tree. The picture lives
/// in memory until it is posted. It is never written to a file or a log.
@MainActor final class HandsObserver {
  private struct Picture: @unchecked Sendable {
    let base64: String, width: Int, height: Int
    let captureMs: Int, encodeMs: Int, bytes: Int
    /// Transient capture image kept only during the observe call for optional OCR grounding.
    let cgImage: CGImage?
  }

  /// What the looks of the command that runs cost, for the timing of its step. The controller sets it
  /// back at the start of each command.
  var spent = HandsCost()

  /// The app in front. ClawdTime is never its own subject: `OwnWindows.subject` holds the rule.
  private var frontApp: NSRunningApplication? {
    let front = NSWorkspace.shared.frontmostApplication, menuBar = NSWorkspace.shared.menuBarOwningApplication
    let subject = OwnWindows.subject(front: front.map { Int($0.processIdentifier) },
                                     menuBar: menuBar.map { Int($0.processIdentifier) }, own: Int(getpid()))
    if let front, subject == Int(front.processIdentifier) { return front }
    if let menuBar, subject == Int(menuBar.processIdentifier) { return menuBar }
    return nil
  }

  /// What the screen shows now. The caller has checked the rights that `image` and `elements` need.
  /// The picture and the walk of the tree run at the same time: neither waits for the other. A look
  /// with no image takes no picture at all.
  func observe(image: Bool, elements: Bool, accessibility: Bool, pointer: CGPoint,
               coverFrames: [CGRect] = [], appOverride: NSRunningApplication? = nil) async -> Result<Observation, HandError> {
    guard let display = HandsDisplay.main else { return .failure(.failed) }
    let map = display.map
    let app = appOverride ?? frontApp
    let pid = accessibility ? app?.processIdentifier : nil
    let bounds = CGRect(x: 0, y: 0, width: map.width, height: map.height)
    async let taken: Picture? = image ? capture(display, keepImage: elements) : nil
    var window = "", found: [ScreenElement] = [], rawElements: [RawElement] = [], readFrame = bounds, readFrames: [CGRect] = [bounds]
    if let pid {
      let began = Date()
      // The tree is read off the main thread: an app that is slow to answer does not freeze the mascot.
      let read = await Task.detached(priority: .userInitiated) {
        HandsTree.read(pid: pid, elements: elements, screen: bounds, coverFrames: coverFrames)
      }.value
      spent.add(HandsCost(walkMs: HandsCost.milliseconds(Date().timeIntervalSince(began))))
      window = read.window
      rawElements = read.elements
      readFrame = read.frame
      readFrames = read.frames
      found = ElementCleaner.clean(rawElements, within: readFrame)
    }
    let picture = await taken
    // A picture that was asked for and could not be taken fails the look.
    if image && picture == nil { return .failure(.failed) }
    if let picture { spent.add(HandsCost(captureMs: picture.captureMs, encodeMs: picture.encodeMs, imageBytes: picture.bytes)) }
    if elements, image, let cgImage = picture?.cgImage, ScreenOCR.shouldRun(axElements: found) {
      let ocrBegan = Date()
      let existing = found
      let ocrRects = readFrames
      let ocrRaw = await Task.detached(priority: .userInitiated) {
        ScreenOCR.recognize(cgImage, map: map, existing: existing, within: ocrRects)
      }.value
      spent.add(HandsCost(ocrMs: HandsCost.milliseconds(Date().timeIntervalSince(ocrBegan))))
      if !ocrRaw.isEmpty {
        found = ElementCleaner.clean(rawElements + ocrRaw, within: readFrame)
      }
    }
    let rawName = app?.localizedName ?? ""
    let appName = !rawName.isEmpty ? rawName : (appOverride != nil ? (app?.bundleIdentifier ?? "") : "")
    let seen = Observation(at: (Date().timeIntervalSince1970 * 1000).rounded(),
      screen: .init(width: map.width, height: map.height, scale: map.scale),
      cursor: .init(x: Double(pointer.x), y: Double(pointer.y)),
      app: .init(name: ElementCleaner.line(appName, limit: 120), bundleId: ElementCleaner.line(app?.bundleIdentifier ?? "", limit: 200),
                 window: ElementCleaner.line(window)),
      elements: found, image: picture?.base64, imageWidth: picture?.width, imageHeight: picture?.height)
    return .success(seen)
  }

  /// A closer look: a picture of one part of the main display, `width` by `height` pixels, with ClawdTime's own
  /// windows left out. The observation names the app in front and has no elements: they are those of the last look.
  func closer(x: Double, y: Double, w: Double, h: Double, width: Int, height: Int, pointer: CGPoint) async -> Result<Observation, HandError> {
    guard let display = HandsDisplay.main else { return .failure(.failed) }
    let map = display.map
    guard let part = HandsZoom.region(x: x, y: y, w: w, h: h, display: CGRect(x: 0, y: 0, width: map.width, height: map.height))
      else { return .failure(.refused) }
    // The picture keeps the shape of the part that is on the display.
    let wide = min(Double(width), Double(height) * Double(part.width / part.height))
    let pixels = (width: max(16, Int(wide.rounded())), height: max(16, Int((wide * Double(part.height / part.width)).rounded())))
    guard let taken = await capture(display, part: part, pixels: pixels) else { return .failure(.failed) }
    let app = frontApp
    return .success(Observation(at: (Date().timeIntervalSince1970 * 1000).rounded(),
      screen: .init(width: map.width, height: map.height, scale: map.scale),
      cursor: .init(x: Double(pointer.x), y: Double(pointer.y)),
      app: .init(name: ElementCleaner.line(app?.localizedName ?? "", limit: 120), bundleId: ElementCleaner.line(app?.bundleIdentifier ?? "", limit: 200),
                 window: ""),
      elements: [], image: taken.base64, imageWidth: taken.width, imageHeight: taken.height))
  }

  /// One picture of the main display with ClawdTime's own windows left out, as a JPEG in base64. The
  /// display draws the picture at the size of `ScreenMap`, so no full-size picture is ever made here,
  /// and the JPEG is written off the main thread. With `part`, only that part of the display, in points
  /// from the top left, at `pixels`. Nil when it cannot be taken or does not fit.
  private func capture(_ display: HandsDisplay, part: CGRect? = nil, pixels: (width: Int, height: Int)? = nil, keepImage: Bool = false) async -> Picture? {
    let began = Date()
    do {
      let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
      guard let screen = content.displays.first(where: { $0.displayID == display.id }) else { return nil }
      // The windows also carry a sharing type that keeps them out. This filter does not depend on it.
      let own = content.applications.filter { $0.processID == getpid() }
      let filter = SCContentFilter(display: screen, excludingApplications: own, exceptingWindows: [])
      let settings = SCStreamConfiguration()
      settings.width = pixels?.width ?? display.map.imageWidth; settings.height = pixels?.height ?? display.map.imageHeight
      // A part of the display is scaled to the asked size: without scalesToFit it stays at its own size in a
      // corner of the picture, and the rest is empty (measured on the laptop, 23 Nov 2026).
      if let part { settings.sourceRect = part; settings.scalesToFit = true }
      settings.showsCursor = true; settings.capturesAudio = false
      let frame = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: settings)
      let captured = Date()
      let written = await Task.detached(priority: .userInitiated) { () -> (String, Int)? in
        guard let jpeg = ScreenPicture.encode(frame) else { return nil }
        return (jpeg.base64EncodedString(), jpeg.count)
      }.value
      guard let written else { return nil }
      return Picture(base64: written.0, width: frame.width, height: frame.height,
        captureMs: HandsCost.milliseconds(captured.timeIntervalSince(began)),
        encodeMs: HandsCost.milliseconds(Date().timeIntervalSince(captured)), bytes: written.1,
        cgImage: keepImage ? frame : nil)
    } catch { return nil }
  }
}

/// Reads the Accessibility tree of one app's front window. Plain functions with
/// no state, so they run on any thread.
enum HandsTree {
  struct Reading: Sendable {
    var window = ""
    /// The bounding union of on-screen window frames read. Elements outside it are left out.
    var frame: CGRect
    /// Separate on-screen window rectangles (front window plus any matched popover/dropdown covers).
    var frames: [CGRect] = []
    var elements: [RawElement] = []
  }
  private static let attributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute,
    kAXPlaceholderValueAttribute, kAXPositionAttribute, kAXSizeAttribute, kAXEnabledAttribute, kAXFocusedAttribute,
    kAXTitleUIElementAttribute, kAXChildrenAttribute, kAXVisibleChildrenAttribute, kAXVisibleRowsAttribute, kAXHeaderAttribute]

  /// The window in front and, when `elements` is true, what it shows (plus any same-app non-standalone
  /// popover/dropdown windows matching `coverFrames`). The walk keeps the order of the tree, leaves out
  /// every part of the window that does not show, and stops at `WalkLimits.look`.
  static func read(pid: pid_t, elements: Bool, screen: CGRect, coverFrames: [CGRect] = []) -> Reading {
    var reading = Reading(frame: screen, frames: [screen])
    let app = AXUIElementCreateApplication(pid)
    // One slow answer never holds the walk for long: for this app, and for every element that this process asks.
    AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.3)
    AXUIElementSetMessagingTimeout(app, 0.3)
    guard let window = element(one(app, kAXFocusedWindowAttribute)) ?? element(one(app, kAXMainWindowAttribute))
      ?? list(one(app, kAXWindowsAttribute)).first else { return reading }
    reading.window = text(one(window, kAXTitleAttribute)) ?? ""
    if let origin = point(one(window, kAXPositionAttribute)), let size = size(one(window, kAXSizeAttribute)) {
      let shown = CGRect(origin: origin, size: size).intersection(screen)
      if !shown.isNull, !shown.isEmpty {
        reading.frame = shown
        reading.frames = [shown]
      }
    }
    guard elements else { return reading }
    let deadline = ProcessInfo.processInfo.systemUptime + WalkLimits.look.seconds
    func visitNode(_ node: AXUIElement, visible: CGRect) -> WalkVisit<AXUIElement> {
      let values = many(node, attributes)
      let role = text(values[0]) ?? "", subrole = text(values[1])
      var frame: CGRect?
      if let origin = point(values[6]), let size = size(values[7]) { frame = CGRect(origin: origin, size: size) }
      var raw: RawElement?
      // An element that does not show is not read further: its label is one more question to the app.
      if let frame, !role.isEmpty, !AccessibilityWalk.offScreen(frame, visible: visible) {
        // A password field is never read: what it holds stops here.
        let secure = ElementCleaner.isSecure(role: role, subrole: subrole)
        raw = RawElement(role: role, subrole: subrole,
          label: element(values[10]).flatMap { text(one($0, kAXTitleAttribute)) ?? text(one($0, kAXValueAttribute)) },
          title: text(values[2]), description: text(values[3]), placeholder: text(values[5]),
          value: secure ? nil : text(values[4]), frame: frame,
          enabled: flag(values[8]) ?? true, focused: flag(values[9]) ?? false)
      }
      let children = AccessibilityWalk.children(role: role, all: list(values[11]), visibleChildren: list(values[12]),
                                                visibleRows: list(values[13]), header: element(values[14]))
      return WalkVisit(element: raw, frame: frame, children: children)
    }
    let visible = reading.frame
    let walked = AccessibilityWalk.walk(from: window, limits: .look, visible: visible, clock: { ProcessInfo.processInfo.systemUptime }) { node in
      visitNode(node, visible: visible)
    }
    reading.elements = walked.elements
    var totalVisited = walked.visited
    if !coverFrames.isEmpty, totalVisited < WalkLimits.look.visits, ProcessInfo.processInfo.systemUptime < deadline {
      func matchesFrame(_ a: CGRect, _ b: CGRect) -> Bool {
        abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
      }
      let axWindows = list(one(app, kAXWindowsAttribute))
      for candidate in axWindows.prefix(32) {
        guard totalVisited < WalkLimits.look.visits else { break }
        let remaining = deadline - ProcessInfo.processInfo.systemUptime
        guard remaining > 0 else { break }
        guard !CFEqual(candidate, window) else { continue }
        let info = many(candidate, [kAXRoleAttribute, kAXSubroleAttribute, kAXPositionAttribute, kAXSizeAttribute])
        let role = text(info[0]), subrole = text(info[1])
        guard !DesktopWindowVisibility.standsAlone(role: role, subrole: subrole),
              let origin = point(info[2]), let size = size(info[3]) else { continue }
        let candidateFrame = CGRect(origin: origin, size: size)
        guard coverFrames.contains(where: { matchesFrame($0, candidateFrame) }) else { continue }
        let coverVisible = candidateFrame.intersection(screen)
        guard !coverVisible.isNull, !coverVisible.isEmpty else { continue }
        let limits = WalkLimits(visits: max(1, WalkLimits.look.visits - totalVisited), depth: WalkLimits.look.depth, seconds: remaining)
        let extra = AccessibilityWalk.walk(from: candidate, limits: limits, visible: coverVisible, clock: { ProcessInfo.processInfo.systemUptime }) { node in
          visitNode(node, visible: coverVisible)
        }
        reading.elements.append(contentsOf: extra.elements)
        reading.frame = reading.frame.union(coverVisible).intersection(screen)
        reading.frames.append(coverVisible)
        totalVisited += extra.visited
      }
    }
    return reading
  }

  /// The frame and password-field state of the element that has the keyboard, in one Accessibility read.
  static func focusInfo() -> (frame: CGRect?, secure: Bool?) {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    guard let focused = element(one(system, kAXFocusedUIElementAttribute)) else { return (nil, nil) }
    let values = many(focused, [kAXPositionAttribute, kAXSizeAttribute, kAXRoleAttribute, kAXSubroleAttribute])
    let frame: CGRect?
    if let origin = point(values[0]), let size = size(values[1]) { frame = CGRect(origin: origin, size: size) }
    else { frame = nil }
    let secure = text(values[2]).map { ElementCleaner.isSecure(role: $0, subrole: text(values[3])) }
    return (frame, secure)
  }

  /// Whether the element that has the keyboard is a password field. Nil when the tree does not say.
  static func focusIsSecure() -> Bool? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    guard let focused = element(one(system, kAXFocusedUIElementAttribute)) else { return nil }
    let values = many(focused, [kAXRoleAttribute, kAXSubroleAttribute])
    guard let role = text(values[0]) else { return nil }
    return ElementCleaner.isSecure(role: role, subrole: text(values[1]))
  }

  /// Whether the element at `point`, in screen points from the top left, is a password field. Nil when the tree does not say.
  static func isSecure(at point: CGPoint) -> Bool? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    var found: AXUIElement?
    guard point.x.isFinite, point.y.isFinite,
      AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &found) == .success, let found else { return nil }
    let values = many(found, [kAXRoleAttribute, kAXSubroleAttribute])
    guard let role = text(values[0]) else { return nil }
    return ElementCleaner.isSecure(role: role, subrole: text(values[1]))
  }

  /// The frame of the element that has the keyboard, in screen points from the top left. Nil when the tree does not say.
  static func focusFrame() -> CGRect? {
    let system = AXUIElementCreateSystemWide()
    AXUIElementSetMessagingTimeout(system, 0.3)
    guard let focused = element(one(system, kAXFocusedUIElementAttribute)) else { return nil }
    let values = many(focused, [kAXPositionAttribute, kAXSizeAttribute])
    guard let origin = point(values[0]), let size = size(values[1]) else { return nil }
    return CGRect(origin: origin, size: size)
  }

  private static func one(_ node: AXUIElement, _ name: String) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(node, name as CFString, &value) == .success else { return nil }
    return value
  }
  /// Several attributes in one call. One that the element does not have comes back as nil.
  private static func many(_ node: AXUIElement, _ names: [String]) -> [AnyObject?] {
    var values: CFArray?
    guard AXUIElementCopyMultipleAttributeValues(node, names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
      let found = values as? [AnyObject], found.count == names.count else { return Array(repeating: nil, count: names.count) }
    return found.map { item in
      if item is NSNull { return nil }
      if CFGetTypeID(item) == AXValueGetTypeID(), AXValueGetType(item as! AXValue) == .axError { return nil }
      return item
    }
  }
  /// A text, a number as text, or the plain text of a styled one. Only its start: a field can hold a whole document.
  private static func text(_ value: AnyObject?) -> String? {
    if let string = value as? String { return String(string.prefix(4000)) }
    if let number = value as? NSNumber { return number.stringValue }
    if let styled = value as? NSAttributedString { return String(styled.string.prefix(4000)) }
    return nil
  }
  private static func flag(_ value: AnyObject?) -> Bool? { (value as? NSNumber)?.boolValue }
  private static func point(_ value: AnyObject?) -> CGPoint? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(value as! AXValue, .cgPoint, &point) ? point : nil
  }
  private static func size(_ value: AnyObject?) -> CGSize? {
    guard let value, CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(value as! AXValue, .cgSize, &size) ? size : nil
  }
  private static func element(_ value: AnyObject?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
  }
  private static func list(_ value: AnyObject?) -> [AXUIElement] {
    guard let items = value as? [AnyObject] else { return [] }
    return items.compactMap { element($0) }
  }
}
