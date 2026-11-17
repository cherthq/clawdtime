import AppKit
import ApplicationServices
import CryptoKit
import DeviceCore
import ScreenCaptureKit

struct CameraGeometry: Codable, Equatable {
  var width: Int; var height: Int
  var originX: Double; var originY: Double
  var pointWidth: Double; var pointHeight: Double
  var displayOriginX: Double; var displayOriginY: Double
  var displayPointWidth: Double; var displayPointHeight: Double
}
struct CameraFrameMetadata: Codable {
  var version: Int = 1
  var surface: CameraSurface
  var geometryGeneration: String
  var contentRevision: String
  var source: CameraGeometry
}
struct CameraCapturedFrame {
  var jpeg: Data
  var metadata: CameraFrameMetadata
}

struct CameraSurfaceDiagnostic: Codable {
  let surface: CameraSurface
  let onScreen: Bool
  let windowFrame: [Double]
  let filterContentRect: [Double]
  let pointPixelScale: Double
  let displayBounds: [Double]
}

extension ScreenCapture {
  private func cameraLifecycleWitnesses(pid: pid_t) -> [WindowLifecycleWitness] {
    guard AXIsProcessTrusted() else { return [] }
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, 0.15)
    var raw: CFTypeRef?
    guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &raw) == .success,
      var windows = raw as? [AXUIElement], windows.count <= 32 else { return [] }
    // Finder can omit an off-Space document from AXWindows while exposing that
    // same window through these public references. Deduplicate element identity,
    // then still require unique AX and SCK geometry for the exact captured ID.
    for attribute in [kAXMainWindowAttribute, kAXFocusedWindowAttribute] {
      var reference: CFTypeRef?
      if AXUIElementCopyAttributeValue(app, attribute as CFString, &reference) == .success,
        let reference, CFGetTypeID(reference) == AXUIElementGetTypeID() {
        let window = reference as! AXUIElement
        if !windows.contains(where: { CFEqual($0, window) }) { windows.append(window) }
      }
    }
    let deadline = Date().addingTimeInterval(0.5)
    var witnesses = [WindowLifecycleWitness]()
    for window in windows {
      guard Date() < deadline else { return [] }
      AXUIElementSetMessagingTimeout(window, 0.1)
      var position: CFTypeRef?; var size: CFTypeRef?; var minimized: CFTypeRef?
      guard AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
        AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
        let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return [] }
      var point = CGPoint.zero; var dimensions = CGSize.zero
      guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
        AXValueGetValue(size as! AXValue, .cgSize, &dimensions) else { return [] }
      let result = AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized)
      witnesses.append(WindowLifecycleWitness(frame: CGRect(origin: point, size: dimensions),
        minimized: result == .success ? minimized as? Bool : nil))
    }
    return witnesses
  }

  private func cameraWindowAvailable(_ window: SCWindow, windows: [SCWindow]) -> Bool {
    guard let owner = window.owningApplication,
      let app = NSRunningApplication(processIdentifier: owner.processID), !app.isTerminated else { return false }
    return WindowCapturePolicy.available(frame: window.frame, onScreen: window.isOnScreen,
      active: window.isActive, appHidden: app.isHidden,
      witnesses: window.isOnScreen || window.isActive ? [] : cameraLifecycleWitnesses(pid: owner.processID),
      matchingCaptureWindows: windows.filter { $0.windowLayer == 0 && $0.owningApplication?.processID == owner.processID && $0.frame == window.frame }.count)
  }
  func cameraInspectQuery(bundleId: String, title: String) async throws -> [[String: String]] {
    guard !bundleId.isEmpty, bundleId.utf8.count <= 160, !title.isEmpty, title.utf8.count <= 640,
      CGPreflightScreenCaptureAccess() else { throw HelperError(403, "Exact query and existing Screen Recording permission are required.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let cgWindows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    var rows = [[String: String]]()
    for window in content.windows where window.owningApplication?.bundleIdentifier == bundleId {
      var row = [String: String]()
      row["id"] = String(window.windowID)
      row["ownerPid"] = String(window.owningApplication!.processID)
      row["hasTitle"] = window.title?.isEmpty == false ? "true" : "false"
      row["titleMatches"] = window.title == title ? "true" : "false"
      row["onScreen"] = window.isOnScreen ? "true" : "false"
      row["active"] = window.isActive ? "true" : "false"
      row["layer"] = String(window.windowLayer)
      if let cg = cgWindows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window.windowID }) {
        row["cgOnScreen"] = (cg[kCGWindowIsOnscreen as String] as? Bool) == true ? "true" : "false"
        row["cgAlpha"] = String((cg[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? -1)
      }
      row["x"] = String(Double(window.frame.minX)); row["y"] = String(Double(window.frame.minY))
      row["width"] = String(Double(window.frame.width)); row["height"] = String(Double(window.frame.height))
      rows.append(row)
      if rows.count == 32 { break }
    }
    var ax = ["accessibilityTrusted": AXIsProcessTrusted() ? "true" : "false"]
    if AXIsProcessTrusted(), let app = content.applications.first(where: { $0.bundleIdentifier == bundleId }) {
      let application = AXUIElementCreateApplication(app.processID)
      AXUIElementSetMessagingTimeout(application, 0.3)
      for (key, attribute) in [("axMain", kAXMainWindowAttribute), ("axFocused", kAXFocusedWindowAttribute)] {
        var rawWindow: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(application, attribute as CFString, &rawWindow)
        ax[key + "ReadStatus"] = String(status.rawValue)
        guard status == .success, let rawWindow, CFGetTypeID(rawWindow) == AXUIElementGetTypeID() else { continue }
        let window = rawWindow as! AXUIElement
        AXUIElementSetMessagingTimeout(window, 0.1)
        var position: CFTypeRef?; var size: CFTypeRef?; var minimized: CFTypeRef?
        if AXUIElementCopyAttributeValue(window, kAXPositionAttribute as CFString, &position) == .success,
          AXUIElementCopyAttributeValue(window, kAXSizeAttribute as CFString, &size) == .success,
          let position, let size, CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() {
          var point = CGPoint.zero; var dimensions = CGSize.zero
          if AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &dimensions) {
            ax[key + "Geometry"] = "\(point.x),\(point.y),\(dimensions.width),\(dimensions.height)"
          }
        }
        if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
          let minimized = minimized as? Bool { ax[key + "Minimized"] = minimized ? "true" : "false" }
      }
      var value: CFTypeRef?
      if AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
        let windows = value as? [AXUIElement] {
        ax["axWindowCount"] = String(windows.count)
        let witnesses = cameraLifecycleWitnesses(pid: app.processID)
        if let selected = content.windows.first(where: { $0.title == title && $0.owningApplication?.processID == app.processID }) {
          let matching = witnesses.filter { $0.frame == selected.frame }
          ax["axGeometryMatches"] = String(matching.count)
          ax["appHidden"] = NSRunningApplication(processIdentifier: app.processID)?.isHidden == true ? "true" : "false"
          ax["captureAvailable"] = cameraWindowAvailable(selected, windows: content.windows) ? "true" : "false"
          if matching.count == 1 { ax["axGeometryMinimized"] = matching[0].minimized.map { $0 ? "true" : "false" } ?? "unknown" }
        }
        let matches = windows.filter { window in
          AXUIElementSetMessagingTimeout(window, 0.3)
          var titleValue: CFTypeRef?
          let result = AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &titleValue)
          ax["axTitleReadStatus"] = String(result.rawValue)
          ax["axHasTitle"] = titleValue as? String == nil ? "false" : "true"
          return result == .success && titleValue as? String == title
        }
        ax["axTitleMatches"] = String(matches.count)
        if windows.count == 1, let window = windows.first {
          var minimized: CFTypeRef?
          if AXUIElementCopyAttributeValue(window, kAXMinimizedAttribute as CFString, &minimized) == .success,
            let flag = minimized as? Bool { ax["axMinimized"] = flag ? "true" : "false" }
          for (key, attribute, type) in [("axPosition", kAXPositionAttribute, AXValueType.cgPoint), ("axSize", kAXSizeAttribute, AXValueType.cgSize)] {
            var raw: CFTypeRef?
            let readStatus = AXUIElementCopyAttributeValue(window, attribute as CFString, &raw)
            ax[key + "ReadStatus"] = String(readStatus.rawValue)
            if readStatus == .success, let raw,
              CFGetTypeID(raw) == AXValueGetTypeID() {
              if type == .cgPoint {
                var point = CGPoint.zero
                if AXValueGetValue(raw as! AXValue, type, &point) { ax[key] = "\(point.x),\(point.y)" }
              } else {
                var size = CGSize.zero
                if AXValueGetValue(raw as! AXValue, type, &size) { ax[key] = "\(size.width),\(size.height)" }
              }
            }
          }
        }
      }
    }
    rows.append(ax)
    return rows
  }

  func cameraFindWindow(bundleId: String, title: String) async throws -> CameraSurface {
    guard !bundleId.isEmpty, bundleId.utf8.count <= 160, !title.isEmpty, title.utf8.count <= 640,
      !title.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      CGPreflightScreenCaptureAccess() else {
      throw HelperError(403, "Exact bundle/title query and existing Screen Recording permission are required.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    let matches = content.windows.filter {
      $0.windowLayer == 0 && $0.title == title && $0.owningApplication?.bundleIdentifier == bundleId
    }
    guard matches.count == 1, let window = matches.first, let owner = window.owningApplication else {
      throw HelperError(409, "Exact selected window is missing or ambiguous; open only the intended disposable window.")
    }
    guard cameraWindowAvailable(window, windows: content.windows) else { throw HelperError(409, "Selected window is minimized, hidden, or its lifecycle cannot be verified.") }
    let displays = content.displays.filter { CGDisplayBounds($0.displayID).contains(window.frame) }
    guard displays.count == 1, let display = displays.first else {
      throw HelperError(409, "Selected window must be wholly inside one active display.")
    }
    return CameraSurface(kind: "window", id: String(window.windowID), displayId: display.displayID, ownerPid: Int(owner.processID))
  }

  func cameraInspect(_ surface: CameraSurface) async throws -> CameraSurfaceDiagnostic {
    try surface.validate(display: surface.displayId)
    guard CGPreflightScreenCaptureAccess(), CGDisplayIsActive(surface.displayId) != 0 else {
      throw HelperError(403, "Existing screen permission and selected active display are required.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let display = content.displays.first(where: { $0.displayID == surface.displayId }) else {
      throw HelperError(404, "Selected display is unavailable.")
    }
    let filter: SCContentFilter
    let bounds: CGRect
    let onScreen: Bool
    if surface.kind == "window" {
      guard let window = content.windows.first(where: { String($0.windowID) == surface.id }),
        window.owningApplication.map({ Int($0.processID) }) == surface.ownerPid else {
        throw HelperError(409, "Exact selected window identity is unavailable.")
      }
      filter = SCContentFilter(desktopIndependentWindow: window); bounds = window.frame; onScreen = window.isOnScreen
    } else {
      filter = SCContentFilter(display: display, excludingWindows: []); bounds = CGDisplayBounds(surface.displayId); onScreen = true
    }
    func values(_ rect: CGRect) -> [Double] { [rect.minX, rect.minY, rect.width, rect.height] }
    return CameraSurfaceDiagnostic(surface: surface, onScreen: onScreen, windowFrame: values(bounds),
      filterContentRect: values(filter.contentRect), pointPixelScale: Double(filter.pointPixelScale), displayBounds: values(CGDisplayBounds(surface.displayId)))
  }

  func cameraSurfaces() async throws -> [CameraSurface] {
    guard CGPreflightScreenCaptureAccess() else { throw HelperError(403, "Screen Recording permission is missing; grant explicitly in macOS Settings.") }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    var result = content.displays.map { CameraSurface(kind: "display", id: String($0.displayID), displayId: $0.displayID) }
    for window in content.windows where window.isOnScreen && window.windowLayer == 0 {
      guard let app = window.owningApplication,
        let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(window.frame) }),
        window.frame.width >= 1, window.frame.height >= 1 else { continue }
      result.append(CameraSurface(kind: "window", id: String(window.windowID), displayId: display.displayID, ownerPid: Int(app.processID)))
      if result.count >= 128 { break }
    }
    return result
  }

  func cameraTarget(_ surface: CameraSurface, initial: Bool = false) async throws -> (SCContentFilter, CameraGeometry) {
    try surface.validate(display: surface.displayId)
    guard CGPreflightScreenCaptureAccess(), CGDisplayIsActive(surface.displayId) != 0 else {
      throw HelperError(403, "Screen permission and the selected active display are required.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
    guard let display = content.displays.first(where: { $0.displayID == surface.displayId }) else {
      throw HelperError(404, "Selected display is unavailable.")
    }
    let displayBounds = CGDisplayBounds(surface.displayId)
    let filter: SCContentFilter
    let bounds: CGRect
    if surface.kind == "window" {
      guard let window = content.windows.first(where: { String($0.windowID) == surface.id }) else {
        throw HelperError(409, "Exact selected window ID is absent from ScreenCaptureKit.")
      }
      guard window.owningApplication.map({ Int($0.processID) }) == surface.ownerPid else {
        throw HelperError(409, "Exact selected window owner no longer matches.")
      }
      guard window.windowLayer == 0 else {
        throw HelperError(409, "Exact selected window is no longer a normal application window.")
      }
      guard window.frame.width > 0, window.frame.height > 0 else {
        throw HelperError(409, "Exact selected window has empty geometry.")
      }
      let others = content.displays.filter { $0.displayID != surface.displayId && CGDisplayIsActive($0.displayID) != 0 }.map { CGDisplayBounds($0.displayID) }
      guard WindowCapturePolicy.placementAllowed(frame: window.frame, selectedDisplay: displayBounds, otherDisplays: others, initial: initial) else {
        throw HelperError(409, initial ? "Initially selected window must be wholly inside its authorized display and overlap no other display." : "Selected window intersects another active display; select it again explicitly.")
      }
      guard cameraWindowAvailable(window, windows: content.windows) else { throw HelperError(409, "Selected window is minimized, hidden, or its lifecycle cannot be verified.") }
      filter = SCContentFilter(desktopIndependentWindow: window)
      bounds = window.frame
    } else {
      filter = SCContentFilter(display: display, excludingWindows: [])
      bounds = displayBounds
    }
    let scale = Double(filter.pointPixelScale)
    let width = Int((bounds.width * scale).rounded())
    let height = Int((bounds.height * scale).rounded())
    guard width > 0, height > 0, width <= 8192, height <= 8192, width * height <= 32_000_000 else {
      throw HelperError(413, "Selected surface exceeds native camera pixel bounds.")
    }
    return (filter, CameraGeometry(width: width, height: height, originX: bounds.minX, originY: bounds.minY,
      pointWidth: bounds.width, pointHeight: bounds.height, displayOriginX: displayBounds.minX,
      displayOriginY: displayBounds.minY, displayPointWidth: displayBounds.width, displayPointHeight: displayBounds.height))
  }

  func cameraFrame(_ surface: CameraSurface) async throws -> CameraCapturedFrame {
    guard !busy else { throw HelperError(409, "A frame is already being captured.") }
    busy = true; defer { busy = false }
    let filter: SCContentFilter
    let geometry: CameraGeometry
    do { (filter, geometry) = try await cameraTarget(surface) }
    catch let error as HelperError { throw error }
    catch { throw CaptureFailure(.targetBefore, underlying: error) }
    let config = SCStreamConfiguration()
    config.width = geometry.width; config.height = geometry.height
    config.showsCursor = false; config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.preservesAspectRatio = true
    // sourceRect is intentionally unused: ScreenCaptureKit ignores it for windows.
    let image = try await surface.kind == "window"
      ? CameraSingleFrameStream().capture(filter: filter, configuration: config)
      : SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let after: CameraGeometry
    do { (_, after) = try await cameraTarget(surface) }
    catch let error as HelperError { throw error }
    catch { throw CaptureFailure(.targetAfter, underlying: error) }
    guard geometry == after else {
      throw HelperError(425, "Selected surface geometry changed during capture (origin \(geometry.originX),\(geometry.originY) to \(after.originX),\(after.originY); size \(geometry.pointWidth)x\(geometry.pointHeight) to \(after.pointWidth)x\(after.pointHeight)).")
    }
    guard image.width == geometry.width, image.height == geometry.height else {
      throw HelperError(409, "Native capture dimensions differ from selected geometry (expected \(geometry.width)x\(geometry.height), returned \(image.width)x\(image.height)).")
    }
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]), data.count <= 2 * 1024 * 1024 else {
      throw HelperError(413, "Native camera frame exceeds 2 MiB; select a smaller window.")
    }
    return CameraCapturedFrame(jpeg: data, metadata: CameraFrameMetadata(surface: surface,
      geometryGeneration: try fingerprint(geometry),
      contentRevision: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), source: geometry))
  }
}
