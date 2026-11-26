import CoreGraphics
import Foundation

/// How the guided cursor moves. `fast` is the pace of work: a brisk glide with a low cap, so the screen has
/// little chance to change before the input. `calm` is for a person who watches from far away, on a recording
/// or on a call that shows the screen: a slower glide, eased at both ends, a short trail that fades, and a
/// clear pulse at each click. Reduce Motion wins over both: the cursor jumps and nothing glides.
public enum CursorPace: String, Equatable, Sendable {
  case fast, calm

  /// The setting that chooses the pace, for the panel.
  public static let setting = "CLAWDTIME_CURSOR_PACE"

  /// The pace that the setting names: `calm` or `fast`, in any case. Nil for no setting, and for a value that
  /// names no pace: the pace then follows the screen.
  public static func named(_ value: String?) -> CursorPace? {
    value.flatMap { CursorPace(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) }
  }
  /// The pace of one glide. A setting that names a pace wins. With none, the pace is calm while the screen is
  /// recorded or shown on a call, and fast otherwise.
  public static func choose(setting value: String?, recording: Bool, shownOnCall: Bool) -> CursorPace {
    named(value) ?? (recording || shownOnCall ? .calm : .fast)
  }
}

/// The short trail of the calm cursor: marks where its tip was in the last moments of a glide. The newest mark
/// is the largest and the most solid; the older ones are smaller and fainter. The trail ends with the glide.
public enum GuidedTrail {
  /// Seconds of the way that the trail covers, and the most marks in it.
  public static let span = 0.18, count = 7
  /// The radius of the newest and of the oldest mark, in points, and the opacity of the newest one.
  public static let headRadius = 4.0, tailRadius = 1.6, headOpacity = 0.55
  /// A mark this near the tip lies under the arrow: it is left out.
  public static let underArrow = 6.0
  public struct Mark: Equatable, Sendable {
    public let point: CGPoint, radius: Double, opacity: Double
    public init(point: CGPoint, radius: Double, opacity: Double) { self.point = point; self.radius = radius; self.opacity = opacity }
  }
  /// The marks at `time` seconds into `path`, newest first. None at the fast pace, with Reduce Motion, for a
  /// way with no glide, at the start and after the end of the glide.
  public static func marks(on path: GuidedPath, at time: Double, pace: CursorPace, still: Bool) -> [Mark] {
    guard pace == .calm, !still, path.duration > 0, time.isFinite, time > 0, time < path.duration else { return [] }
    let tip = path.point(at: time), step = span / Double(count)
    var marks: [Mark] = []
    for index in 1...count {
      let then = time - step * Double(index)
      guard then > 0 else { break }
      let point = path.point(at: then)
      guard hypot(Double(point.x - tip.x), Double(point.y - tip.y)) >= underArrow else { continue }
      // 1 for the newest mark, near 0 for the oldest.
      let share = 1 - Double(index - 1) / Double(count)
      marks.append(Mark(point: point, radius: tailRadius + (headRadius - tailRadius) * share, opacity: headOpacity * share))
    }
    return marks
  }
}

/// The pulse of a click at the calm pace: the copy of the rays opens more slowly, and a thin ring opens around
/// the tip and fades. The ring stays inside the window of the cursor and inside the part of it that a call
/// video frames. At the fast pace the click keeps `GuidedClick` alone.
public enum GuidedClickRing {
  /// Seconds for the calm pulse, the ring's radius at the start and at the end, in points, and its line.
  public static let duration = 0.48, startRadius = 5.0, endRadius = 17.0, line = 2.0
  public struct Frame: Equatable, Sendable {
    public let radius: Double, opacity: Double
    public init(radius: Double, opacity: Double) { self.radius = radius; self.opacity = opacity }
  }
  /// `count` frames from the click to its end, evenly in time. It opens fast and slows down, and it fades on
  /// the way. None with Reduce Motion, and none at the fast pace.
  public static func frames(count: Int = 13, pace: CursorPace, still: Bool) -> [Frame] {
    guard pace == .calm, !still, count >= 2 else { return [] }
    return (0..<count).map { index in
      let t = Double(index) / Double(count - 1)
      return Frame(radius: startRadius + (endRadius - startRadius) * (1 - pow(1 - t, 3)), opacity: 0.8 * (1 - t))
    }
  }
  /// Seconds for the copy of the rays at a click, at each pace.
  public static func raysDuration(pace: CursorPace) -> Double { pace == .calm ? duration : GuidedClick.duration }
}

/// Signs that macOS records the screen now: one of its own recorders runs. The screenshot tool of macOS
/// runs `screencaptureui` while it records, and the command line recorder is `screencapture`. A screenshot
/// runs them too, for a moment: the cursor is then calm for that moment, which does no harm.
public enum ScreenRecordingSign {
  public static let recorders: Set<String> = ["screencapture", "screencaptureui"]
  /// True when one of `processes`, by the short names that macOS gives its processes, is a recorder.
  public static func recording(processes: [String]) -> Bool { processes.contains(where: recorders.contains) }
}
