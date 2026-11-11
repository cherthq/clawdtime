import AppKit
import ApplicationServices
import Carbon
import DeviceCore
import ScreenCaptureKit

struct DisplayInfo: Codable {
  var id: UInt32
  var width: Int
  var height: Int
}
struct CapturedFrame {
  var jpeg: Data
  var width: Int
  var height: Int
}
@MainActor final class ScreenCapture {
  var busy = false
  func displays() async throws -> [DisplayInfo] {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count <= 32 else {
      throw HelperError(503, "Cannot enumerate active displays.")
    }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else {
      throw HelperError(503, "Cannot enumerate active displays.")
    }
    return ids.prefix(Int(count)).map {
      DisplayInfo(id: $0, width: CGDisplayPixelsWide($0), height: CGDisplayPixelsHigh($0))
    }
  }
  func capture(_ displayId: UInt32) async throws -> CapturedFrame {
    guard !busy else { throw HelperError(409, "A frame is already being captured.") }
    guard CGPreflightScreenCaptureAccess() else {
      throw HelperError(403, "Screen Recording permission is missing.")
    }
    busy = true
    defer { busy = false }
    let content = try await SCShareableContent.excludingDesktopWindows(
      false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
      throw HelperError(404, "Selected display is unavailable.")
    }
    let scale = min(1, min(1280 / Double(display.width), 720 / Double(display.height)))
    let config = SCStreamConfiguration()
    config.width = max(1, Int(Double(display.width) * scale))
    config.height = max(1, Int(Double(display.height) * scale))
    config.showsCursor = true
    config.capturesAudio = false
    let filter = SCContentFilter(display: display, excludingWindows: [])
    let image = try await SCScreenshotManager.captureImage(
      contentFilter: filter, configuration: config)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.7]),
      data.count <= 2 * 1024 * 1024
    else { throw HelperError(503, "Frame exceeds its bounded JPEG budget.") }
    return CapturedFrame(jpeg: data, width: image.width, height: image.height)
  }
}

@MainActor final class LocalSessionGuard {
  var forcedUnavailable = false
  var available: Bool {
    guard !forcedUnavailable, let session = CGSessionCopyCurrentDictionary() as? [String: Any],
      session[kCGSessionOnConsoleKey as String] as? Bool == true,
      session[kCGSessionLoginDoneKey as String] as? Bool == true
    else { return false }
    // macOS also exposes lock state here on supported builds; distributed lock
    // notifications below disarm immediately. Physical lock acceptance is
    // required for each installed OS; session activity alone is insufficient.
    return session["CGSSessionScreenIsLocked"] as? Bool != true
  }
}

@MainActor func postInput(_ action: InputAction, displayId: UInt32) throws {
  guard AXIsProcessTrusted(), !IsSecureEventInputEnabled(), CGDisplayIsActive(displayId) != 0 else {
    throw HelperError(403, "Accessibility, active display and non-secure input are required.")
  }
  let bounds = CGDisplayBounds(displayId)
  if action.type == "type" {
    // Keyboard input goes to the focused UI element. Reject elements on a
    // different display instead of assuming the selected screen has focus.
    var focused: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(
        AXUIElementCreateSystemWide(), kAXFocusedUIElementAttribute as CFString, &focused)
        == .success, let focused
    else { throw HelperError(409, "No accessible focused element on the selected display.") }
    guard CFGetTypeID(focused) == AXUIElementGetTypeID() else {
      throw HelperError(409, "Invalid focused element.")
    }
    let element = focused as! AXUIElement
    var position: CFTypeRef?
    var size: CFTypeRef?
    guard
      AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &position)
        == .success,
      AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &size) == .success,
      let position, let size, CFGetTypeID(position) == AXValueGetTypeID(),
      CFGetTypeID(size) == AXValueGetTypeID()
    else { throw HelperError(409, "Cannot verify the focused element's display.") }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
      AXValueGetValue(size as! AXValue, .cgSize, &dimensions),
      bounds.contains(CGRect(origin: point, size: dimensions))
    else { throw HelperError(409, "Focus must be wholly inside the selected display.") }
    var chunks = [[UInt16]]()
    var current = [UInt16]()
    for scalar in action.text!.unicodeScalars {
      let encoded = Array(String(scalar).utf16)
      if current.count + encoded.count > 20 {
        chunks.append(current)
        current = []
      }
      current += encoded
    }
    if !current.isEmpty { chunks.append(current) }
    for part in chunks {
      guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true),
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
      else { throw HelperError(503, "Unable to create keyboard event.") }
      part.withUnsafeBufferPointer { buffer in
        down.keyboardSetUnicodeString(stringLength: part.count, unicodeString: buffer.baseAddress)
        up.keyboardSetUnicodeString(stringLength: part.count, unicodeString: buffer.baseAddress)
      }
      down.flags = []
      up.flags = []
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    }
  } else {
    let point = CGPoint(
      x: bounds.minX + CGFloat(action.x!) * max(0, bounds.width - 1),
      y: bounds.minY + CGFloat(action.y!) * max(0, bounds.height - 1))
    if action.type == "click" {
      guard
        let down = CGEvent(
          mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point,
          mouseButton: .left),
        let up = CGEvent(
          mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point,
          mouseButton: .left)
      else { throw HelperError(503, "Unable to create mouse event.") }
      down.flags = []
      up.flags = []
      down.post(tap: .cghidEventTap)
      up.post(tap: .cghidEventTap)
    } else {
      guard
        let event = CGEvent(
          scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: action.deltaY!,
          wheel2: 0, wheel3: 0)
      else { throw HelperError(503, "Unable to create scroll event.") }
      event.location = point
      event.flags = []
      event.post(tap: .cghidEventTap)
    }
  }
}
