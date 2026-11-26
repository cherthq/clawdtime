import AppKit
import ApplicationServices
import CryptoKit
import DeviceCore

/// Read-only metadata qualification. Contains no input or activation operations.
@MainActor final class NativeTargetResolver {
  private(set) var refusalReason = "target_unavailable"
  private(set) var refusalIsCGGeometry = false
  private func refuse<T>(_ reason: String) -> T? { refusalReason = reason; return nil }

  private func read(_ object: AXUIElement, _ key: String) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(object, key as CFString, &value) == .success else { return nil }
    return value
  }
  private func frame(_ element: AXUIElement) -> CGRect? {
    guard let rawPoint = read(element, kAXPositionAttribute), let rawSize = read(element, kAXSizeAttribute),
      CFGetTypeID(rawPoint) == AXValueGetTypeID(), CFGetTypeID(rawSize) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero; var size = CGSize.zero
    guard AXValueGetValue(rawPoint as! AXValue, .cgPoint, &point), AXValueGetValue(rawSize as! AXValue, .cgSize, &size) else { return nil }
    return CGRect(origin: point, size: size)
  }
  private func targetFrame<R: PreviewTargetRequest>(_ request: R) -> CGRect? {
    guard let b = request.target.bounds else { return nil }
    return CGRect(x: b.x, y: b.y, width: b.width, height: b.height)
  }
  func available<R: PreviewTargetRequest>(_ request: R) -> Bool {
    if let refusal = LocalSessionGuard().refusal { refusalReason = refusal.rawValue; return false }
    if !AXIsProcessTrusted() { refusalReason = "accessibility_permission_missing"; return false }
    if !CGPreflightScreenCaptureAccess() { refusalReason = "screen_permission_missing"; return false }
    if !request.valid(now: Date().timeIntervalSince1970 * 1000) { refusalReason = "native_request_expired_or_invalid"; return false }
    if CGDisplayIsActive(request.displayId) == 0 { refusalReason = "display_inactive"; return false }
    if !(targetFrame(request).map { CGDisplayBounds(request.displayId).contains($0) } ?? request.allowsUnqualifiedBounds) {
      refusalReason = "window_outside_display"; return false
    }
    return true
  }
  private func cgWitness<R: PreviewTargetRequest>(_ request: R) -> [String: Any]? {
    refusalIsCGGeometry = false
    guard let infos = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return refuse("cg_list_unavailable") }
    guard infos.count <= 4096 else { return refuse("cg_list_bound") }
    guard let exact = infos.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == request.target.windowId }) else { return refuse("cg_window_missing") }
    guard (exact[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.target.pid else { return refuse("cg_owner_changed") }
    guard let raw = exact[kCGWindowBounds as String] as? NSDictionary, let expected = CGRect(dictionaryRepresentation: raw) else { return refuse("cg_bounds_unavailable") }
    guard CGDisplayBounds(request.displayId).contains(expected) else { refusalIsCGGeometry = true; return refuse("window_outside_display") }
    guard targetFrame(request).map({ $0 == expected }) ?? true else { refusalIsCGGeometry = true; return refuse("cg_geometry_changed") }
    let matches = infos.filter { info in
      guard (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.target.pid,
        let bounds = info[kCGWindowBounds as String] as? NSDictionary,
        let rect = CGRect(dictionaryRepresentation: bounds) else { return false }
      return rect == expected
    }
    guard matches.count == 1, let info = matches.first,
      (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == request.target.windowId else { return refuse("cg_geometry_ambiguous") }
    return info
  }
  func resolve<R: PreviewTargetRequest>(_ request: R) -> (NSRunningApplication, AXUIElement, R, ProcessLifetimeIdentity)? {
    refusalReason = "target_unavailable"
    refusalIsCGGeometry = false
    guard available(request), let cg = cgWitness(request) else { return nil }
    guard let rawBounds = cg[kCGWindowBounds as String] as? NSDictionary, let expected = CGRect(dictionaryRepresentation: rawBounds) else { return refuse("cg_bounds_unavailable") }
    guard let app = NSRunningApplication(processIdentifier: request.target.pid) else { return refuse("app_unavailable") }
    guard !app.isTerminated else { return refuse("app_terminated") }
    guard app.bundleIdentifier == request.target.bundleId else { return refuse("app_bundle_changed") }
    guard let identity = processLifetime(app) else { return refuse("app_launch_identity_unavailable") }
    let root = AXUIElementCreateApplication(request.target.pid)
    AXUIElementSetMessagingTimeout(root, 0.1)
    guard let listed = read(root, kAXWindowsAttribute) as? [AXUIElement] else { return refuse("ax_windows_unavailable") }
    guard listed.count <= 32 else { return refuse("ax_window_bound") }
    var supplemental = [AXUIElement]()
    for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
      if let reference = read(root, attribute), CFGetTypeID(reference) == AXUIElementGetTypeID() {
        supplemental.append(reference as! AXUIElement)
      }
    }
    guard let windows = BoundedWindowCandidates.merge(listed, supplemental: supplemental, same: { CFEqual($0, $1) }) else { return refuse("ax_window_bound") }
    let deadline = ProcessInfo.processInfo.systemUptime + 0.6
    var matches = [(AXUIElement, String)]()
    var candidateReason = "ax_target_missing"
    for window in windows {
      guard ProcessInfo.processInfo.systemUptime < deadline else { return refuse("ax_read_deadline") }
      AXUIElementSetMessagingTimeout(window, 0.1)
      guard let title = read(window, kAXTitleAttribute) as? String, title.utf8.count <= 4096 else { candidateReason = "ax_title_unavailable"; continue }
      guard let observedFrame = frame(window) else { candidateReason = "ax_geometry_unavailable"; continue }
      guard observedFrame == expected else { continue }
      let hash = SHA256.hash(data: Data(title.utf8)).map { String(format: "%02x", $0) }.joined()
      guard request.target.titleHash.map({ hash == $0 }) ?? true else { candidateReason = "ax_title_changed"; continue }
      guard read(window, kAXMinimizedAttribute) as? Bool == false else { candidateReason = "ax_minimized_or_unavailable"; continue }
      matches.append((window, hash))
    }
    guard !matches.isEmpty else { return refuse(candidateReason) }
    guard matches.count == 1 else { return refuse("ax_target_ambiguous") }
    guard available(request) else { return nil }
    let bounds = PreviewNativeBounds(x: expected.minX, y: expected.minY, width: expected.width, height: expected.height)
    guard !app.isTerminated, processLifetime(app) == identity else { return refuse("app_launch_identity_unavailable") }
    return (app, matches[0].0, request.resolving(titleHash: matches[0].1, bounds: bounds), identity)
  }
  func observation<R: PreviewTargetRequest>(_ request: R, app: NSRunningApplication, window: AXUIElement, lifetime: ProcessLifetimeIdentity) -> [String: Any] {
    let root = AXUIElementCreateApplication(request.target.pid)
    AXUIElementSetMessagingTimeout(root, 0.1)
    let focus = read(root, kAXFocusedWindowAttribute)
    let focused = focus.map { CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, window) } ?? false
    let identity = SHA256.hash(data: Data(lifetime.stableMaterial.utf8)).map { String(format: "%02x", $0) }.joined()
    let b = request.target.bounds!
    return ["window": ["appId": request.target.bundleId, "ownerPid": request.target.pid, "windowId": String(request.target.windowId), "displayId": request.displayId],
      "observedAt": Date().timeIntervalSince1970 * 1000, "processIdentity": identity,
      "windowBounds": ["x": b.x, "y": b.y, "width": b.width, "height": b.height], "appActive": app.isActive && NSWorkspace.shared.frontmostApplication?.isEqual(app) == true,
      "windowFocused": focused, "windowOnScreen": cgWitness(request)?[kCGWindowIsOnscreen as String] as? Bool == true]
  }

  /// Post-effect observation only: tolerate moving CG geometry, never a new
  /// identity or a changed display grant. This does not qualify any effect or
  /// return a foreground witness; normal exact resolution must subsequently pass.
  func retainsTransitionIdentity<R: PreviewTargetRequest>(_ request: R, app: NSRunningApplication,
      window: AXUIElement, lifetime: ProcessLifetimeIdentity, displayBounds: CGRect) -> Bool {
    guard available(request), CGDisplayBounds(request.displayId) == displayBounds,
      !app.isTerminated, app.processIdentifier == request.target.pid,
      app.bundleIdentifier == request.target.bundleId, processLifetime(app) == lifetime,
      let currentApp = NSRunningApplication(processIdentifier: request.target.pid), currentApp.isEqual(app),
      processLifetime(currentApp) == lifetime,
      targetFrame(request) != nil,
      let infos = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]], infos.count <= 4096 else { return false }
    let exact = infos.filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == request.target.windowId }
    guard exact.count == 1, let info = exact.first,
      (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.target.pid,
      let raw = info[kCGWindowBounds as String] as? NSDictionary, let moving = CGRect(dictionaryRepresentation: raw),
      !moving.isEmpty, !moving.isInfinite, !moving.isNull,
      [moving.origin.x, moving.origin.y, moving.width, moving.height].allSatisfy({ $0.isFinite }) else { return false }
    let sameGeometry = infos.filter { item in
      guard (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == request.target.pid,
        let bounds = item[kCGWindowBounds as String] as? NSDictionary,
        let value = CGRect(dictionaryRepresentation: bounds) else { return false }
      return value == moving
    }
    guard sameGeometry.count == 1 else { return false }
    // Geometry may already have returned while this separate identity check was
    // running. Still return only pending; the next strict resolver must verify.
    let root = AXUIElementCreateApplication(request.target.pid)
    AXUIElementSetMessagingTimeout(root, 0.1)
    AXUIElementSetMessagingTimeout(window, 0.1)
    guard let listed = read(root, kAXWindowsAttribute) as? [AXUIElement], listed.count <= 32 else { return false }
    var supplemental = [AXUIElement]()
    for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
      if let reference = read(root, attribute), CFGetTypeID(reference) == AXUIElementGetTypeID() {
        supplemental.append(reference as! AXUIElement)
      }
    }
    guard let windows = BoundedWindowCandidates.merge(listed, supplemental: supplemental, same: { CFEqual($0, $1) }),
      windows.contains(where: { CFEqual($0, window) }), read(window, kAXMinimizedAttribute) as? Bool == false,
      let title = read(window, kAXTitleAttribute) as? String, title.utf8.count <= 4096,
      request.target.titleHash == SHA256.hash(data: Data(title.utf8)).map({ String(format: "%02x", $0) }).joined(),
      !app.isTerminated, processLifetime(app) == lifetime,
      CGDisplayBounds(request.displayId) == displayBounds, available(request) else { return false }
    return true
  }
}
