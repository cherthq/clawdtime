import Foundation

/// Fixed diagnostic categories; never serialize native error text or userInfo.
public struct CaptureFailure: Error {
  public enum Reason: String, CaseIterable {
    case outputRegistration = "output_registration"
    case streamStart = "stream_start"
    case streamInterrupted = "stream_interrupted"
    case frameDeadline = "frame_deadline"
    case frameDecode = "frame_decode"
    case stopDeadline = "stop_deadline"
    case stopFailed = "stop_failed"
    case targetBefore = "target_before"
    case targetAfter = "target_after"
  }
  public let reason: Reason
  public let nativeCode: Int?
  public init(_ reason: Reason, underlying: Error? = nil) {
    self.reason = reason
    let code = underlying.map { ($0 as NSError).code }
    nativeCode = code.flatMap { (-99999...99999).contains($0) ? $0 : nil }
  }
  public var headers: [String: String] {
    var result = ["X-ClawdTime-Capture-Error": reason.rawValue]
    if let nativeCode { result["X-ClawdTime-Capture-Code"] = String(nativeCode) }
    return result
  }
}
