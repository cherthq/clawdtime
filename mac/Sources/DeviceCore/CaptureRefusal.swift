/// A fixed reason for refusing selected-camera pixels. No native text, window
/// identity, geometry, titles or other user content can enter the wire value.
public struct CaptureRefusal: Error {
  public enum Reason: String, CaseIterable {
    case windowMissing = "window_missing"
    case windowOwnerChanged = "window_owner_changed"
    case windowOwnerUnavailable = "window_owner_unavailable"
    case windowLayer = "window_layer"
    case windowGeometry = "window_geometry"
    case initialPlacement = "initial_placement"
    case otherDisplay = "other_display"
    case appHidden = "app_hidden"
    case captureWindowAmbiguous = "capture_window_ambiguous"
    case lifecycleWitnessUnavailable = "lifecycle_witness_unavailable"
    case lifecycleWitnessAmbiguous = "lifecycle_witness_ambiguous"
    case lifecycleWitnessUnreadable = "lifecycle_witness_unreadable"
    case windowMinimized = "window_minimized"
    case captureBusy = "capture_busy"
    case captureDimensions = "capture_dimensions"
    case authorityChanged = "authority_changed"
    case frameStale = "frame_stale"
    case displayChanged = "display_changed"
  }
  public let reason: Reason
  public let status = 409
  public init(_ reason: Reason) { self.reason = reason }
  public var headers: [String: String] { ["X-ClawdTime-Camera-Refusal": reason.rawValue] }
}
