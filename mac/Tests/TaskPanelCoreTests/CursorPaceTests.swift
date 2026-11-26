import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// The calm pace of the guided cursor, for a recording or a call that shows the screen, and the fast pace of
/// work, which stays as it was. Plain numbers: no window opens and nothing moves on the screen.
final class CursorPaceTests: XCTestCase {
  private let ways: [(CGPoint, CGPoint)] = [
    (CGPoint(x: 100, y: 100), CGPoint(x: 900, y: 600)),
    (CGPoint(x: 1300, y: 120), CGPoint(x: 400, y: 300)),
    (CGPoint(x: 400, y: 300), CGPoint(x: 460, y: 320)),
  ]

  func testTheGlideTakesAboutHalfASecondWhenCalmAndStaysBriskWhenFast() {
    // The fast pace: the same numbers as before, to the last digit.
    for length in stride(from: -50.0, through: 5000, by: 25) {
      XCTAssertEqual(GuidedPath.glideDuration(length: length, pace: .fast), GuidedPath.glideDuration(length: length))
    }
    XCTAssertEqual(GuidedPath.glideDuration(length: 0, pace: .fast), 0.08)
    XCTAssertEqual(GuidedPath.glideDuration(length: 400, pace: .fast), 0.13, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 1500, pace: .fast), 0.15)
    XCTAssertEqual(GuidedPath.glideDuration(length: .nan, pace: .fast), 0.08)
    // The calm pace: 0.35 seconds for a short way, a little longer for a long one, and never more than 0.6.
    XCTAssertEqual(GuidedPath.glideDuration(length: 0, pace: .calm), 0.35)
    XCTAssertEqual(GuidedPath.glideDuration(length: -40, pace: .calm), 0.35)
    XCTAssertEqual(GuidedPath.glideDuration(length: 80, pace: .calm), 0.37, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 400, pace: .calm), 0.45, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 800, pace: .calm), 0.55, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 1000, pace: .calm), 0.60, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 1500, pace: .calm), 0.60)
    XCTAssertEqual(GuidedPath.glideDuration(length: 100_000, pace: .calm), 0.60)
    XCTAssertEqual(GuidedPath.glideDuration(length: .nan, pace: .calm), 0.35)
    XCTAssertEqual(GuidedPath.glideDuration(length: .infinity, pace: .calm), 0.35)
    var before = 0.0
    for length in stride(from: 0.0, through: 4000, by: 50) {
      let calm = GuidedPath.glideDuration(length: length, pace: .calm)
      XCTAssertGreaterThanOrEqual(calm, before)
      XCTAssertGreaterThanOrEqual(calm, 0.35); XCTAssertLessThanOrEqual(calm, 0.60)
      // A calm glide is always well slower than a fast one: the eye can follow it on a recording.
      XCTAssertGreaterThanOrEqual(calm, GuidedPath.glideDuration(length: length) * 2.5)
      before = calm
    }
  }

  func testACalmWayHasTheSameShapeAndOnlyTakesLonger() {
    for (start, target) in ways {
      let fast = GuidedPath.glide(from: start, to: target, still: false)
      // The way with no pace named is the fast way, as before.
      XCTAssertEqual(GuidedPath.glide(from: start, to: target, still: false, pace: .fast), fast)
      XCTAssertEqual(fast.duration, GuidedPath.glideDuration(length: fast.length))
      let calm = GuidedPath.glide(from: start, to: target, still: false, pace: .calm)
      XCTAssertEqual(calm.duration, GuidedPath.glideDuration(length: calm.length, pace: .calm))
      XCTAssertEqual(calm.bend, fast.bend); XCTAssertEqual(calm.start, start); XCTAssertEqual(calm.target, target)
      // The same share of the way is at the same place: the calm glide is the fast one, slowed down.
      for share in [0.0, 0.1, 0.25, 0.5, 0.75, 0.9] {
        let a = fast.point(at: fast.duration * share), b = calm.point(at: calm.duration * share)
        XCTAssertEqual(a.x, b.x, accuracy: 0.000_1); XCTAssertEqual(a.y, b.y, accuracy: 0.000_1)
      }
      XCTAssertEqual(calm.point(at: calm.duration), target)
      // Slow at both ends: the first and the last tenth of the time cover far less than a tenth of the way.
      XCTAssertLessThan(calm.progress(at: calm.duration * 0.1), 0.02)
      XCTAssertGreaterThan(calm.progress(at: calm.duration * 0.9), 0.98)
      // Reduce Motion wins over the calm pace: a jump.
      XCTAssertEqual(GuidedPath.glide(from: start, to: target, still: true, pace: .calm).duration, 0)
    }
    // Already at the target: no glide at either pace.
    let here = CGPoint(x: 400, y: 300)
    XCTAssertEqual(GuidedPath.glide(from: here, to: CGPoint(x: 401, y: 301), still: false, pace: .calm).duration, 0)
  }

  func testTheSettingWinsAndWithoutItARecordingOrACallMakesTheCursorCalm() {
    for (recording, call) in [(false, false), (true, false), (false, true), (true, true)] {
      XCTAssertEqual(CursorPace.choose(setting: "calm", recording: recording, shownOnCall: call), .calm)
      XCTAssertEqual(CursorPace.choose(setting: "fast", recording: recording, shownOnCall: call), .fast)
      XCTAssertEqual(CursorPace.choose(setting: " Calm\n", recording: recording, shownOnCall: call), .calm)
      XCTAssertEqual(CursorPace.choose(setting: "FAST", recording: recording, shownOnCall: call), .fast)
      // No setting, an empty one, or one that names no pace: the screen decides.
      for setting in [nil, "", "slow", "on"] as [String?] {
        XCTAssertEqual(CursorPace.choose(setting: setting, recording: recording, shownOnCall: call), recording || call ? .calm : .fast)
      }
    }
    XCTAssertNil(CursorPace.named(nil)); XCTAssertNil(CursorPace.named("slow")); XCTAssertEqual(CursorPace.named("calm"), .calm)
    XCTAssertEqual(CursorPace.setting, "CLAWDTIME_CURSOR_PACE")
  }

  func testTheCalmCursorLeavesAShortTrailThatFadesAndEndsWithTheGlide() {
    let path = GuidedPath.glide(from: CGPoint(x: 100, y: 100), to: CGPoint(x: 900, y: 600), still: false, pace: .calm)
    let middle = path.duration / 2
    let marks = GuidedTrail.marks(on: path, at: middle, pace: .calm, still: false)
    XCTAssertEqual(marks.count, GuidedTrail.count)
    let tip = path.point(at: middle)
    for (index, mark) in marks.enumerated() {
      // Behind the tip, on the way, and never under the arrow.
      XCTAssertGreaterThanOrEqual(hypot(Double(mark.point.x - tip.x), Double(mark.point.y - tip.y)), GuidedTrail.underArrow)
      XCTAssertLessThan(hypot(Double(mark.point.x - path.start.x), Double(mark.point.y - path.start.y)),
                        hypot(Double(tip.x - path.start.x), Double(tip.y - path.start.y)))
      XCTAssertGreaterThan(mark.opacity, 0); XCTAssertLessThanOrEqual(mark.opacity, GuidedTrail.headOpacity)
      XCTAssertGreaterThanOrEqual(mark.radius, GuidedTrail.tailRadius); XCTAssertLessThanOrEqual(mark.radius, GuidedTrail.headRadius)
      // Newest first: each one older is fainter and smaller.
      if index > 0 {
        XCTAssertLessThan(mark.opacity, marks[index - 1].opacity); XCTAssertLessThan(mark.radius, marks[index - 1].radius)
      }
    }
    XCTAssertEqual(marks.first?.opacity, GuidedTrail.headOpacity); XCTAssertEqual(marks.first?.radius, GuidedTrail.headRadius)
    // The trail is short: its oldest mark is at most `span` seconds behind the tip.
    let oldest = path.point(at: middle - GuidedTrail.span)
    XCTAssertLessThanOrEqual(hypot(Double(marks.last!.point.x - tip.x), Double(marks.last!.point.y - tip.y)),
                             hypot(Double(oldest.x - tip.x), Double(oldest.y - tip.y)) + 0.001)
    // No trail at the start, at the end, after it, at the fast pace, with Reduce Motion, or for no glide.
    XCTAssertEqual(GuidedTrail.marks(on: path, at: 0, pace: .calm, still: false), [])
    XCTAssertEqual(GuidedTrail.marks(on: path, at: path.duration, pace: .calm, still: false), [])
    XCTAssertEqual(GuidedTrail.marks(on: path, at: path.duration + 1, pace: .calm, still: false), [])
    XCTAssertEqual(GuidedTrail.marks(on: path, at: .nan, pace: .calm, still: false), [])
    XCTAssertEqual(GuidedTrail.marks(on: path, at: middle, pace: .fast, still: false), [])
    XCTAssertEqual(GuidedTrail.marks(on: path, at: middle, pace: .calm, still: true), [])
    let none = GuidedPath.glide(from: tip, to: tip, still: false, pace: .calm)
    XCTAssertEqual(GuidedTrail.marks(on: none, at: 0.1, pace: .calm, still: false), [])
    // Near the start the trail has only the marks that the way has behind it already.
    XCTAssertLessThan(GuidedTrail.marks(on: path, at: 0.05, pace: .calm, still: false).count, GuidedTrail.count)
  }

  func testACalmClickPulsesWithARingThatStaysInTheCursorAndAFastClickIsUnchanged() {
    // The fast click is as it was: the copy of the rays alone, in 0.32 seconds.
    XCTAssertEqual(GuidedClick.duration, 0.32)
    XCTAssertEqual(GuidedClickRing.raysDuration(pace: .fast), GuidedClick.duration)
    XCTAssertEqual(GuidedClickRing.frames(pace: .fast, still: false), [])
    XCTAssertEqual(GuidedClickRing.frames(pace: .calm, still: true), [])
    XCTAssertEqual(GuidedClickRing.frames(count: 1, pace: .calm, still: false), [])
    // The calm click: slower, with a ring that opens and fades once.
    XCTAssertEqual(GuidedClickRing.raysDuration(pace: .calm), 0.48)
    let ring = GuidedClickRing.frames(pace: .calm, still: false)
    XCTAssertEqual(ring.count, 13)
    XCTAssertEqual(ring.first, .init(radius: GuidedClickRing.startRadius, opacity: 0.8))
    XCTAssertEqual(ring.last?.radius ?? 0, GuidedClickRing.endRadius, accuracy: 0.000_001)
    XCTAssertEqual(ring.last?.opacity ?? 1, 0, accuracy: 0.000_001)
    for (before, after) in zip(ring, ring.dropFirst()) {
      XCTAssertGreaterThan(after.radius, before.radius); XCTAssertLessThan(after.opacity, before.opacity)
    }
    // At its widest the ring is inside the window of the cursor, and inside what a call video frames of it.
    let outer = GuidedClickRing.endRadius + GuidedClickRing.line / 2
    XCTAssertLessThanOrEqual(outer, GuidedLayout.reach)
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
    for tip in [CGPoint(x: 700, y: 400), CGPoint(x: 1500, y: 10)] {
      for pill in [0.0, 160] {
        let layout = GuidedLayout(tip: tip, pillWidth: pill, screen: screen)
        let around = CGRect(x: tip.x - outer, y: tip.y - outer, width: outer * 2, height: outer * 2)
        XCTAssertTrue(layout.paintedBounds.contains(around))
        XCTAssertTrue(layout.window.contains(around))
      }
    }
  }

  func testOnlyTheRecordersOfMacOSCountAsARecording() {
    XCTAssertTrue(ScreenRecordingSign.recording(processes: ["launchd", "Finder", "screencaptureui"]))
    XCTAssertTrue(ScreenRecordingSign.recording(processes: ["screencapture"]))
    XCTAssertFalse(ScreenRecordingSign.recording(processes: ["launchd", "Stonepad", "Riverchat"]))
    XCTAssertFalse(ScreenRecordingSign.recording(processes: ["ScreenCapture", "screencapture-helper", "xscreencaptureui"]))
    XCTAssertFalse(ScreenRecordingSign.recording(processes: []))
  }
}
