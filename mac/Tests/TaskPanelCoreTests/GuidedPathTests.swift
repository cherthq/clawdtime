import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

/// The way of the guided cursor, and what the mascot does while the hands act.
final class GuidedPathTests: XCTestCase {
  let ways: [(CGPoint, CGPoint)] = [
    (CGPoint(x: 1300, y: 120), CGPoint(x: 200, y: 700)), (CGPoint(x: 100, y: 100), CGPoint(x: 900, y: 100)),
    (CGPoint(x: 400, y: 800), CGPoint(x: 400, y: 50)), (CGPoint(x: 10, y: 10), CGPoint(x: 14, y: 12)),
    (CGPoint(x: 0, y: 0), CGPoint(x: 3000, y: 1900)),
  ]
  /// How far `point` is along the line from the start to the target, and how far off it.
  func split(_ point: CGPoint, _ path: GuidedPath) -> (along: Double, across: Double) {
    let dx = Double(path.target.x - path.start.x), dy = Double(path.target.y - path.start.y), length = hypot(dx, dy)
    let px = Double(point.x - path.start.x), py = Double(point.y - path.start.y)
    return ((px * dx + py * dy) / length, abs(px * dy - py * dx) / length)
  }

  func testItStartsAtTheStartAndEndsAtTheTarget() {
    for (start, target) in ways {
      let path = GuidedPath(from: start, to: target)
      XCTAssertEqual(path.duration, 0.30)
      XCTAssertEqual(path.point(at: 0), start)
      XCTAssertEqual(path.point(at: -1), start)
      XCTAssertEqual(path.point(at: path.duration), target)
      XCTAssertEqual(path.point(at: 5), target)
      XCTAssertFalse(path.done(at: 0.29)); XCTAssertTrue(path.done(at: 0.30))
      XCTAssertEqual(path.progress(at: 0), 0); XCTAssertEqual(path.progress(at: path.duration), 1)
    }
  }

  func testItNeverGoesBackwardAndNeverPastTheTarget() {
    for (start, target) in ways {
      let path = GuidedPath(from: start, to: target)
      var before = -1.0
      for frame in 0...300 {
        let now = split(path.point(at: path.duration * Double(frame) / 300), path)
        // Along the line: always forward, and never one point beyond the target.
        XCTAssertGreaterThanOrEqual(now.along, before - 0.000_001)
        XCTAssertGreaterThanOrEqual(now.along, -0.000_001)
        XCTAssertLessThanOrEqual(now.along, path.length + 0.000_001)
        // Across the line: a small swing, bounded in points and as a share of the way.
        XCTAssertLessThanOrEqual(now.across, GuidedPath.maxBend + 0.000_001)
        XCTAssertLessThanOrEqual(now.across, path.length * GuidedPath.arc + 0.000_001)
        before = now.along
      }
      XCTAssertLessThanOrEqual(path.bend, GuidedPath.maxBend)
    }
    // The swing is there, so the cursor reads as a hand and not as a ruler.
    let bent = GuidedPath(from: .zero, to: CGPoint(x: 400, y: 0))
    XCTAssertEqual(split(bent.point(at: 0.15), bent).across, 36, accuracy: 0.000_001)
    XCTAssertEqual(split(bent.point(at: 0.15), bent).along, 200, accuracy: 0.000_001)
  }

  func testTheEaseIsSlowAtBothEnds() {
    XCTAssertEqual(GuidedPath.ease(0), 0); XCTAssertEqual(GuidedPath.ease(1), 1); XCTAssertEqual(GuidedPath.ease(0.5), 0.5)
    XCTAssertEqual(GuidedPath.ease(-3), 0); XCTAssertEqual(GuidedPath.ease(7), 1)
    XCTAssertLessThan(GuidedPath.ease(0.1), 0.1); XCTAssertGreaterThan(GuidedPath.ease(0.9), 0.9)
    var before = 0.0
    for step in 0...1000 {
      let value = GuidedPath.ease(Double(step) / 1000)
      XCTAssertGreaterThanOrEqual(value, before); XCTAssertLessThanOrEqual(value, 1)
      before = value
    }
  }

  func testWithReduceMotionTheCursorIsAtTheTargetAtOnce() {
    let path = GuidedPath(from: CGPoint(x: 1300, y: 120), to: CGPoint(x: 200, y: 700), still: true)
    XCTAssertEqual(path.duration, 0); XCTAssertEqual(path.bend, 0)
    XCTAssertEqual(path.point(at: 0), CGPoint(x: 200, y: 700))
    XCTAssertEqual(path.point(at: 0.1), CGPoint(x: 200, y: 700))
    XCTAssertTrue(path.done(at: 0))
    XCTAssertEqual(path.points(every: 1.0 / 120), [CGPoint(x: 200, y: 700)])
    // A way with no length, and numbers with no meaning, give the target too.
    XCTAssertEqual(GuidedPath(from: CGPoint(x: 5, y: 5), to: CGPoint(x: 5, y: 5)).point(at: 0.1), CGPoint(x: 5, y: 5))
    XCTAssertEqual(GuidedPath(from: .zero, to: CGPoint(x: 9, y: 9), duration: .nan).point(at: 0), CGPoint(x: 9, y: 9))
    XCTAssertEqual(GuidedPath(from: .zero, to: CGPoint(x: 9, y: 9)).point(at: .nan), CGPoint(x: 9, y: 9))
  }

  func testTheRealPointerTravelsAShortCurvedWayThatTheEyeSees() {
    let start = CGPoint(x: 100, y: 100), target = CGPoint(x: 900, y: 500)
    let length = hypot(800.0, 400.0)
    let path = GuidedPath(from: start, to: target, duration: GuidedPath.moveDuration(length: length), arc: GuidedPath.moveArc)
    let points = path.points(every: 1.0 / 120)
    XCTAssertEqual(points.last, target)
    // At 120 events a second the way has enough steps to be seen, and not so many that it drags.
    XCTAssertGreaterThan(points.count, 10); XCTAssertLessThan(points.count, 24)
    var before = 0.0, widest = 0.0
    for point in points {
      let now = split(point, path)
      widest = max(widest, abs(now.across))
      XCTAssertGreaterThanOrEqual(now.along, before); XCTAssertLessThanOrEqual(now.along, length + 0.000_001)
      before = now.along
    }
    // A slight bend, as a hand makes, and never a wide swing.
    XCTAssertGreaterThan(widest, 5); XCTAssertLessThanOrEqual(widest, GuidedPath.maxBend + 0.000_001)
    // Already in place takes no time; longer moves stay brisk and capped.
    XCTAssertEqual(GuidedPath.moveDuration(length: 0), 0)
    XCTAssertEqual(GuidedPath.moveDuration(length: 2.9), 0)
    XCTAssertEqual(GuidedPath.moveDuration(length: -10), 0)
    XCTAssertEqual(GuidedPath.moveDuration(length: .nan), 0)
    XCTAssertEqual(GuidedPath.moveDuration(length: .infinity), 0)
    XCTAssertEqual(GuidedPath.moveDuration(length: 100_000), 0.14)
    XCTAssertEqual(GuidedPath.moveDuration(length: 300), 0.09, accuracy: 0.000_001)
    XCTAssertLessThan(GuidedPath.moveDuration(length: 200), GuidedPath.moveDuration(length: 600))
    XCTAssertEqual(GuidedPath.dragDuration(length: 0), 0.14); XCTAssertEqual(GuidedPath.dragDuration(length: 100_000), 0.36)
    XCTAssertEqual(GuidedPath.dragDuration(length: 500), 0.24, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath(from: start, to: target, duration: 0).points(every: 0.01), [target])
    XCTAssertEqual(GuidedPath(from: start, to: target, duration: 99).points(every: 0.001).count, 600)
    XCTAssertEqual(GuidedPath(from: start, to: target, duration: 99).points(every: .leastNonzeroMagnitude).count, 600)
  }

  func testTheGlideIsQuickStillReadsAsAWayAndALongWayTakesLonger() {
    XCTAssertEqual(GuidedPath.glideDuration(length: 0), 0.08)
    XCTAssertEqual(GuidedPath.glideDuration(length: -40), 0.08)
    // A short way, the usual ways and a long one.
    XCTAssertEqual(GuidedPath.glideDuration(length: 80), 0.09, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 160), 0.10, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 320), 0.12, accuracy: 0.000_001)
    XCTAssertEqual(GuidedPath.glideDuration(length: 400), 0.13, accuracy: 0.000_001)
    for length in [150.0, 250, 400] {
      XCTAssertGreaterThanOrEqual(GuidedPath.glideDuration(length: length), 0.09)
      XCTAssertLessThanOrEqual(GuidedPath.glideDuration(length: length), 0.14)
    }
    // The cap: across a whole screen it stays brisk.
    XCTAssertEqual(GuidedPath.glideDuration(length: 1500), 0.15)
    XCTAssertEqual(GuidedPath.glideDuration(length: 100_000), 0.15)
    XCTAssertEqual(GuidedPath.glideDuration(length: .nan), 0.08)
    XCTAssertEqual(GuidedPath.glideDuration(length: .infinity), 0.08)
    var before = 0.0
    for length in stride(from: 0.0, through: 4000, by: 50) {
      let now = GuidedPath.glideDuration(length: length)
      XCTAssertGreaterThanOrEqual(now, before); XCTAssertGreaterThanOrEqual(now, 0.08); XCTAssertLessThanOrEqual(now, 0.15)
      before = now
    }
    // The screen can change between the worker's last look and the event: the glide and the wait stay under 0.2 seconds.
    XCTAssertLessThanOrEqual(GuidedPath.longestGlide + GuidedPath.dwell(still: false), 0.20)
    XCTAssertEqual(GuidedPath.longestLead, 0.20, accuracy: 0.000_001)
    XCTAssertLessThanOrEqual(GuidedPath.dwell(still: true), GuidedPath.longestLead)
    // The way to one target takes the time of its length, and ends on the target.
    for (start, target) in ways {
      let path = GuidedPath.glide(from: start, to: target, still: false)
      XCTAssertEqual(path.duration, GuidedPath.glideDuration(length: path.length))
      XCTAssertEqual(path.point(at: 0), start); XCTAssertEqual(path.point(at: path.duration), target)
      XCTAssertFalse(path.done(at: path.duration - 0.01)); XCTAssertTrue(path.done(at: path.duration))
    }
  }

  func testACursorThatIsAlreadyThereDoesNotGlideAndWaitsOnlyForTheNewLabel() {
    let here = CGPoint(x: 400, y: 300)
    // The next key in the same field: the cursor points there already.
    for target in [here, CGPoint(x: 401, y: 301), CGPoint(x: 402, y: 300)] {
      let path = GuidedPath.glide(from: here, to: target, still: false)
      XCTAssertEqual(path.duration, 0)
      XCTAssertEqual(path.point(at: 0), target)
    }
    // Three points or more is a way, and it glides as before.
    let away = GuidedPath.glide(from: here, to: CGPoint(x: 403, y: 300), still: false)
    XCTAssertEqual(away.duration, GuidedPath.glideDuration(length: 3))
    XCTAssertGreaterThanOrEqual(away.duration, GuidedPath.shortestGlide)
    // The wait at a place that did not change is short, with Reduce Motion too, and never longer than a moved one.
    XCTAssertEqual(GuidedPath.dwell(still: false, moved: false), 0.02)
    XCTAssertEqual(GuidedPath.dwell(still: true, moved: false), 0.02)
    XCTAssertLessThan(GuidedPath.dwell(still: false, moved: false), GuidedPath.dwell(still: false))
    // The next key with the same label at the same place: no glide and no wait at all.
    XCTAssertEqual(GuidedPath.dwell(still: false, moved: false, relabeled: false), 0)
    XCTAssertEqual(GuidedPath.dwell(still: true, moved: false, relabeled: false), 0)
    // A run of keys in one field: every key after the first costs nothing of the cursor.
    let field = CGPoint(x: 520, y: 330)
    let run = (0..<5).map { _ in GuidedPath.glide(from: field, to: field, still: false) }
    XCTAssertEqual(run.map(\.duration), [0, 0, 0, 0, 0])
    XCTAssertEqual(run.map { GuidedPath.dwell(still: false, moved: $0.length >= GuidedPath.inPlace, relabeled: false) }, [0, 0, 0, 0, 0])
    // The cursor stays between two steps: a look and a plan take about two seconds.
    XCTAssertGreaterThanOrEqual(GuidedPath.rest, 2.5)
  }

  func testWithReduceMotionTheGlideIsAJump() {
    for (start, target) in ways {
      let path = GuidedPath.glide(from: start, to: target, still: true)
      XCTAssertEqual(path.duration, 0); XCTAssertEqual(path.bend, 0)
      // No place between the start and the target is ever shown.
      for time in [0, 0.001, 0.2, 0.7, 5] { XCTAssertEqual(path.point(at: time), target) }
      XCTAssertTrue(path.done(at: 0))
    }
    // With no glide to lead the eye, the cursor waits a little longer at the target before the hands act.
    XCTAssertGreaterThan(GuidedPath.dwell(still: true), GuidedPath.dwell(still: false))
    XCTAssertEqual(GuidedPath.dwell(still: false), 0.04)
    XCTAssertEqual(GuidedPath.dwell(still: true), 0.05)
    XCTAssertLessThanOrEqual(GuidedPath.dwell(still: true), 0.06)
    // With Reduce Motion the whole lead before an input is the wait: shorter than any glide with its wait.
    XCTAssertLessThan(GuidedPath.glide(from: .zero, to: CGPoint(x: 900, y: 600), still: true).duration + GuidedPath.dwell(still: true),
                      GuidedPath.shortestGlide + GuidedPath.dwell(still: false))
  }

  func testTheCursorGoesOnFromWhereItIsAndFirstComesOutOfTheMascot() {
    let shown = CGPoint(x: 400, y: 300), mascot = CGPoint(x: 1300, y: 120), pointer = CGPoint(x: 20, y: 880)
    XCTAssertEqual(GuidedPath.origin(shown: shown, mascot: mascot, pointer: pointer), shown)
    XCTAssertEqual(GuidedPath.origin(shown: nil, mascot: mascot, pointer: pointer), mascot)
    XCTAssertEqual(GuidedPath.origin(shown: nil, mascot: nil, pointer: pointer), pointer)
    // A place with no meaning is skipped.
    XCTAssertEqual(GuidedPath.origin(shown: CGPoint(x: CGFloat.nan, y: 0), mascot: mascot, pointer: pointer), mascot)
    XCTAssertEqual(GuidedPath.origin(shown: nil, mascot: CGPoint(x: 0, y: CGFloat.infinity), pointer: pointer), pointer)
    // The cursor stays long enough after a command for the next one to take it on.
    XCTAssertGreaterThanOrEqual(GuidedPath.rest, 1.0)
  }

  func testTheMascotLeansTowardTheTarget() {
    let mascot = CGPoint(x: 800, y: 300)
    // A positive lean is toward the left, as the lean of a tucked mascot is.
    XCTAssertGreaterThan(GuidedPath.lean(from: mascot, to: CGPoint(x: 300, y: 600)), 0)
    XCTAssertLessThan(GuidedPath.lean(from: mascot, to: CGPoint(x: 1300, y: 20)), 0)
    XCTAssertEqual(GuidedPath.lean(from: mascot, to: CGPoint(x: 800, y: 900)), 0)
    XCTAssertEqual(GuidedPath.lean(from: mascot, to: CGPoint(x: -9000, y: 0)), 0.26)
    XCTAssertEqual(GuidedPath.lean(from: mascot, to: CGPoint(x: 9000, y: 0)), -0.26)
    XCTAssertEqual(GuidedPath.lean(from: mascot, to: CGPoint(x: CGFloat.nan, y: 0)), 0)
  }

  func testWhileItTypesTheMascotLooksDownAndTaps() {
    var moving = MascotPose()
    TypingBeat.apply(to: &moving, at: 0.5 / TypingBeat.tapsPerSecond, still: false)
    XCTAssertEqual(moving.pupilY, -0.55); XCTAssertEqual(moving.pitch, 0.08)
    XCTAssertEqual(moving.bob, -0.020, accuracy: 0.000_001); XCTAssertEqual(moving.squash, 0.975, accuracy: 0.000_001)
    // The taps stay small, at every moment.
    for frame in 0...600 {
      var pose = MascotPose()
      TypingBeat.apply(to: &pose, at: Double(frame) / 120, still: false)
      XCTAssertTrue((-0.0201...0).contains(pose.bob)); XCTAssertTrue((0.9749...1).contains(pose.squash)); XCTAssertLessThanOrEqual(abs(pose.roll), 0.0301)
    }
    // With Reduce Motion only the eyes go down.
    var still = MascotPose()
    TypingBeat.apply(to: &still, at: 0.37, still: true)
    var expected = MascotPose(); expected.pupilY = -0.55
    XCTAssertEqual(still, expected)
  }
}
