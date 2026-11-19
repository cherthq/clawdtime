import Foundation

/// Opt-in timing telemetry: a closed phase vocabulary and bounded numbers only.
public struct TaskCaptureTiming: Codable, Equatable {
  public enum Phase: String, Codable, CaseIterable {
    case inputReceived = "input_received"
    case beforeGuard = "before_guard", beforeShareable = "before_shareable", beforeValidate = "before_validate"
    case captureImage = "capture_image"
    case afterGuard = "after_guard", afterShareable = "after_shareable", afterValidate = "after_validate"
    case jpegEncode = "jpeg_encode", responseWrite = "response_write", idle
    case refusedAvailability = "refused_availability", refusedGrant = "refused_grant"
    case refusedDisplay = "refused_display", refusedOwnerMissing = "refused_owner_missing"
    case refusedOwnerHidden = "refused_owner_hidden", refusedOwnerBundle = "refused_owner_bundle"
    case refusedLifetime = "refused_lifetime", refusedEnumeration = "refused_enumeration"
    case refusedWindowMatch = "refused_window_match", refusedOnScreen = "refused_on_screen"
    case refusedLayer = "refused_layer", refusedWindowPID = "refused_window_pid"
    case refusedWindowBundle = "refused_window_bundle", refusedTitle = "refused_title"
    case refusedGeometry = "refused_geometry", refusedDisplayOverlap = "refused_display_overlap"
    case refusedCaptureGeometry = "refused_capture_geometry", refusedImageDimensions = "refused_image_dimensions"
    case refusedCaptureAge = "refused_capture_age", refusedCaptureImage = "refused_capture_image"
    case refusedEncoding = "refused_encoding"
    case streamStart = "stream_start", streamWait = "stream_wait", streamStop = "stream_stop"
    case refusedStreamStop = "refused_stream_stop", refusedStreamFrame = "refused_stream_frame"
  }
  public let phase: Phase
  public let elapsedMs: Int
  public let sequence: Int
  public init(phase: Phase, elapsedMilliseconds: Double, sequence: Int = 0) {
    self.phase = phase
    self.sequence = min(1_000_000, max(0, sequence))
    self.elapsedMs = elapsedMilliseconds.isFinite ? Int(min(1_800_000, max(0, elapsedMilliseconds)).rounded()) : 0
  }
}
