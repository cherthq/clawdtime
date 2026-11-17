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

extension ScreenCapture {
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

  func cameraTarget(_ surface: CameraSurface) async throws -> (SCContentFilter, CameraGeometry) {
    try surface.validate(display: surface.displayId)
    guard CGPreflightScreenCaptureAccess(), CGDisplayIsActive(surface.displayId) != 0 else {
      throw HelperError(403, "Screen permission and the selected active display are required.")
    }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == surface.displayId }) else {
      throw HelperError(404, "Selected display is unavailable.")
    }
    let displayBounds = CGDisplayBounds(surface.displayId)
    let filter: SCContentFilter
    let bounds: CGRect
    if surface.kind == "window" {
      guard let window = content.windows.first(where: { String($0.windowID) == surface.id }),
        window.isOnScreen, window.windowLayer == 0,
        window.owningApplication.map({ Int($0.processID) }) == surface.ownerPid,
        displayBounds.contains(window.frame), window.frame.width > 0, window.frame.height > 0 else {
        throw HelperError(409, "Selected window closed, minimized, moved off its display, or changed owner.")
      }
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
    let (filter, geometry) = try await cameraTarget(surface)
    let config = SCStreamConfiguration()
    config.width = geometry.width; config.height = geometry.height
    config.showsCursor = false; config.capturesAudio = false
    config.ignoreShadowsSingleWindow = true
    config.preservesAspectRatio = true
    // sourceRect is intentionally unused: ScreenCaptureKit ignores it for windows.
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    let (_, after) = try await cameraTarget(surface)
    guard geometry == after else {
      throw HelperError(409, "Selected surface geometry changed during capture.")
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
