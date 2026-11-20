import CoreGraphics
import Foundation

/// The picture of the screen is smaller than the screen. This maps between a
/// pixel of the picture and a point of the screen, and between the two ways
/// that macOS counts the height: from the top, as the contract and the input
/// events do, and from the bottom, as windows do.
public struct ScreenMap: Equatable, Sendable {
  /// The widest picture that the hands send, in pixels.
  public static let maxImageWidth = 1280
  /// The main display in points.
  public let width: Double, height: Double
  /// Pixels for one point: 1 on a plain display, 2 on a dense one.
  public let scale: Double
  /// The picture in pixels.
  public let imageWidth: Int, imageHeight: Int

  /// Nil for a display with no size.
  public init?(width: Double, height: Double, scale: Double, maxImageWidth: Int = ScreenMap.maxImageWidth) {
    guard width.isFinite, height.isFinite, scale.isFinite, width >= 1, height >= 1, scale > 0, maxImageWidth >= 1 else { return nil }
    self.width = width; self.height = height; self.scale = scale
    // The picture never has more pixels than the display, and never more than the limit.
    imageWidth = max(1, min(maxImageWidth, Int((width * scale).rounded())))
    imageHeight = max(1, Int((Double(imageWidth) * height / width).rounded()))
  }
  /// The screen point under a pixel of the picture.
  public func point(pixel: CGPoint) -> CGPoint {
    CGPoint(x: Double(pixel.x) * width / Double(imageWidth), y: Double(pixel.y) * height / Double(imageHeight))
  }
  /// The pixel of the picture that shows a screen point.
  public func pixel(point: CGPoint) -> CGPoint {
    CGPoint(x: Double(point.x) * Double(imageWidth) / width, y: Double(point.y) * Double(imageHeight) / height)
  }
  /// The point is on the main display. The hands act nowhere else.
  public func contains(_ point: CGPoint) -> Bool {
    point.x.isFinite && point.y.isFinite && point.x >= 0 && point.y >= 0 && Double(point.x) <= width && Double(point.y) <= height
  }
  /// The nearest point that an event can carry: the last row and column of the display count.
  public func clamp(_ point: CGPoint) -> CGPoint {
    CGPoint(x: max(0, min(Double(point.x), width - 1)), y: max(0, min(Double(point.y), height - 1)))
  }
  /// A point counted from the top left, as a point counted from the bottom left, and back.
  public func flip(_ point: CGPoint) -> CGPoint { CGPoint(x: point.x, y: CGFloat(height) - point.y) }
  /// A frame counted from the top left, as a frame counted from the bottom left, and back.
  public func flip(_ rect: CGRect) -> CGRect {
    CGRect(x: rect.minX, y: CGFloat(height) - rect.maxY, width: rect.width, height: rect.height)
  }
}

/// A scroll in lines, as wheel events.
public enum ScrollPlan {
  public struct Tick: Equatable, Sendable {
    public let vertical: Int32, horizontal: Int32
    public init(vertical: Int32, horizontal: Int32) { self.vertical = vertical; self.horizontal = horizontal }
  }
  /// One event carries a few lines, as a wheel does. More than `limit` lines in one command is cut.
  public static let linesPerEvent = 5, limit = 60
  /// In the contract a positive dy moves the content up, as a wheel turned
  /// toward the person, and a positive dx moves it left. A wheel event counts
  /// the other way, so both signs turn.
  public static func ticks(dx: Double, dy: Double) -> [Tick] {
    func lines(_ value: Double) -> Int {
      guard value.isFinite, value != 0 else { return 0 }
      // A part of a line is one line: a scroll that was asked for always moves.
      let whole = max(1, Int(abs(value).rounded()))
      return (value > 0 ? -1 : 1) * min(limit, whole)
    }
    var vertical = lines(dy), horizontal = lines(dx)
    var ticks: [Tick] = []
    while vertical != 0 || horizontal != 0 {
      let v = max(-linesPerEvent, min(linesPerEvent, vertical)), h = max(-linesPerEvent, min(linesPerEvent, horizontal))
      ticks.append(Tick(vertical: Int32(v), horizontal: Int32(h)))
      vertical -= v; horizontal -= h
    }
    return ticks
  }
}

/// What the hands may open. The worker's command is a plan that nobody checked.
public enum HandsTarget {
  /// A web address: http or https with a host and no credentials. Any other
  /// scheme can start a program, a file or a call, so it is refused.
  public static func webURL(_ text: String) -> URL? {
    guard (1...2000).contains(text.utf16.count),
      !text.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || $0.properties.isWhitespace }),
      let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
      let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else { return nil }
    return parts.url
  }
  /// An app by the name that a person says, for example "Safari" or "System
  /// Settings". Never a path: nothing with a slash, a colon or a leading dot.
  public static func appName(_ text: String) -> String? {
    var name = text.trimmingCharacters(in: .whitespaces)
    if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
    guard (1...120).contains(name.utf16.count), !name.hasPrefix("."),
      !name.unicodeScalars.contains(where: { $0 == "/" || $0 == ":" || $0.properties.generalCategory == .control }) else { return nil }
    return name
  }
}
