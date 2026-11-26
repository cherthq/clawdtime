import Foundation

/// ScreenCaptureKit captures backing pixels; display bounds can be logical points.
public enum DisplayCapturePolicy {
  public static func unchanged(expectedBounds: CGRect, capturedWidth: Int, capturedHeight: Int,
    currentBounds: CGRect, modePixelWidth: Int?, modePixelHeight: Int?) -> Bool {
    guard let modePixelWidth, let modePixelHeight, modePixelWidth > 0, modePixelHeight > 0 else { return false }
    return expectedBounds == currentBounds && capturedWidth == modePixelWidth && capturedHeight == modePixelHeight
  }
}
