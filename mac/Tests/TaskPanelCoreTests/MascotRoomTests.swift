import CoreGraphics
import XCTest
@testable import TaskPanelCore

/// The mascot sits at the bottom right, where a chat app has its reply box. The worker's picture leaves the
/// mascot out, so the worker sees the box and acts there: before the hands do, the mascot, its bar and its
/// bubble go to the nearest corner where none of them lies on the target. Plain geometry, from the bottom left
/// of the screen as windows count: no window opens.
final class MascotRoomTests: XCTestCase {
  /// The free part of a laptop screen, under the menu bar.
  private let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
  private let size = PetLayout.size(scale: PetLayout.defaultScale)
  /// The reply box of a made-up chat app, along the bottom right of its window.
  private let reply = CGRect(x: 900, y: 20, width: 560, height: 60)
  private let bar = CGSize(width: 86, height: 40), bubble = CGSize(width: 220, height: 61)
  private func pet(_ x: CGFloat, _ y: CGFloat) -> CGRect { CGRect(origin: CGPoint(x: x, y: y), size: size) }
  private func covers(_ room: PetLayout.Room, _ targets: [CGRect], bubble: CGSize? = nil, bar: CGSize? = nil) -> Bool {
    PetLayout.footprint(pet: room.frame, bubble: bubble, controls: bar, in: screen).contains { part in
      targets.contains { !part.intersection($0).isNull && part.intersection($0).width > 0 && part.intersection($0).height > 0 }
    }
  }

  func testAMascotOnTheReplyBoxGoesToTheNearestFreeCornerOfTheSameScreen() throws {
    let here = pet(1380, 30)
    let room = try XCTUnwrap(PetLayout.room(for: [reply], pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    // The top right corner is the nearest one that leaves the box free. The bottom right one is on the box.
    XCTAssertEqual(room, PetLayout.Room(frame: pet(screen.maxX - size.width - 6, screen.maxY - size.height - 6), docked: nil))
    XCTAssertFalse(covers(room, [reply]))
    // With its bar and its bubble, which also go with it, the same corner is free.
    let full = try XCTUnwrap(PetLayout.room(for: [reply], pet: here, docked: nil, bubble: bubble, controls: bar, in: screen))
    XCTAssertEqual(full.frame, room.frame)
    XCTAssertFalse(covers(full, [reply], bubble: bubble, bar: bar))
    // On the left of the screen it goes to the left: the nearest free corner wins.
    let left = CGRect(x: 20, y: 20, width: 420, height: 60)
    let fromLeft = try XCTUnwrap(PetLayout.room(for: [left], pet: pet(40, 10), docked: nil, bubble: nil, controls: nil, in: screen))
    XCTAssertEqual(fromLeft.frame.origin, CGPoint(x: 6, y: screen.maxY - size.height - 6))
  }

  func testAMascotThatCoversNoTargetStays() {
    // The reply box is far from the mascot: nothing moves.
    XCTAssertNil(PetLayout.room(for: [reply], pet: pet(700, 600), docked: nil, bubble: bubble, controls: bar, in: screen))
    // No target, or none that is a place, moves nothing either.
    XCTAssertNil(PetLayout.room(for: [], pet: pet(1380, 30), docked: nil, bubble: nil, controls: nil, in: screen))
    XCTAssertNil(PetLayout.room(for: [CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), .null, .infinite], pet: pet(1380, 30),
                                docked: nil, bubble: nil, controls: nil, in: screen))
    // A target on another screen is never under this mascot.
    XCTAssertNil(PetLayout.room(for: [CGRect(x: 1600, y: 40, width: 300, height: 60)], pet: pet(1380, 30), docked: nil,
                                bubble: nil, controls: nil, in: screen))
  }

  func testTheBubbleAndTheBarCountAsTheMascot() throws {
    let here = pet(700, 300)
    // A button just over the mascot, where its bubble is: the mascot alone does not cover it, the bubble does.
    let placed = PetLayout.bubble(size: bubble, pet: here, in: screen)
    let button = CGRect(x: placed.frame.midX - 30, y: placed.frame.midY - 10, width: 60, height: 20)
    XCTAssertTrue(here.intersection(button).isNull)
    XCTAssertNil(PetLayout.room(for: [button], pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    let room = try XCTUnwrap(PetLayout.room(for: [button], pet: here, docked: nil, bubble: bubble, controls: nil, in: screen))
    XCTAssertFalse(covers(room, [button], bubble: bubble))
    // A field just under the mascot, where its bar hangs.
    let under = PetLayout.controls(size: bar, pet: here, in: screen)
    let field = CGRect(x: under.midX - 20, y: under.minY + 2, width: 40, height: 12)
    XCTAssertNil(PetLayout.room(for: [field], pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    XCTAssertNotNil(PetLayout.room(for: [field], pet: here, docked: nil, bubble: nil, controls: bar, in: screen))
  }

  func testATuckedMascotStaysTuckedAndGoesToTheNearestFreeEndOfAnEdge() throws {
    let shown = PetLayout.docked(side: .right, y: 30, reveal: PetLayout.revealResting, in: screen, size: size)
    // The tucked mascot shows less of itself: the reply box ends before it.
    XCTAssertNil(PetLayout.room(for: [reply], pet: shown, docked: .right, bubble: nil, controls: nil, in: screen))
    // A send button at the very edge is under it.
    let send = CGRect(x: 1478, y: 40, width: 30, height: 30)
    let room = try XCTUnwrap(PetLayout.room(for: [send], pet: shown, docked: .right, bubble: nil, controls: nil, in: screen))
    // The same edge, at its top, and as far out of the screen as before.
    XCTAssertEqual(room.docked, .right)
    XCTAssertEqual(room.frame, PetLayout.docked(side: .right, y: screen.maxY - size.height - 6, reveal: PetLayout.revealResting,
                                                in: screen, size: size))
    XCTAssertFalse(covers(room, [send]))
  }

  func testWhenEveryCornerCoversTheTargetTheMascotTakesTheOneThatCoversLeastOrStays() throws {
    // A text area that fills the screen: no corner is better than here.
    XCTAssertNil(PetLayout.room(for: [screen], pet: pet(1380, 30), docked: nil, bubble: nil, controls: nil, in: screen))
    // A column of the right two thirds, and a row along the bottom and the top: every corner touches one of them.
    // The two corners on the left touch the least, and the nearer of them wins.
    let column = CGRect(x: 500, y: 0, width: 1012, height: 944)
    let bottom = CGRect(x: 0, y: 0, width: 1512, height: 60), top = CGRect(x: 0, y: 884, width: 1512, height: 60)
    let targets = [column, bottom, top], here = pet(1380, 30)
    let room = try XCTUnwrap(PetLayout.room(for: targets, pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    XCTAssertEqual(room.frame.origin, CGPoint(x: 6, y: 6))
    XCTAssertTrue(covers(room, targets))
    XCTAssertLessThan(PetLayout.covered(PetLayout.footprint(pet: room.frame, bubble: nil, controls: nil, in: screen), targets),
                      PetLayout.covered([here], targets) / 2)
  }

  func testAPointOfTheHandsCountsWithTheRoomOfThePointerAroundIt() {
    XCTAssertEqual(PetLayout.target(CGPoint(x: 100, y: 200)), CGRect(x: 88, y: 188, width: 24, height: 24))
    XCTAssertTrue(PetLayout.target(CGPoint(x: CGFloat.nan, y: 0)).isNull)
    // A click on the box under the mascot moves it; one beside the mascot does not.
    let here = pet(1380, 30)
    XCTAssertNotNil(PetLayout.room(for: [PetLayout.target(CGPoint(x: 1420, y: 50))], pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    XCTAssertNil(PetLayout.room(for: [PetLayout.target(CGPoint(x: 1300, y: 50))], pet: here, docked: nil, bubble: nil, controls: nil, in: screen))
    // The time that the hands wait for the mascot is short, and long enough for its spring to arrive.
    XCTAssertGreaterThanOrEqual(PetLayout.roomWait, 0.5); XCTAssertLessThanOrEqual(PetLayout.roomWait, 1.0)
  }

  func testTheWindowsOfClawdTimeAreNeverWhatTheHandsJudgeTheScreenBy() {
    let own = 4242, other = 77
    // The mascot, its bubble and its bar float over every app; the guided cursor and its trail are at the level of a
    // screen saver. None of them counts, at any level, and neither would a window of ClawdTime at the ordinary level.
    for layer in [0, 3, 8, 25, 101, 999, 1000] { XCTAssertFalse(OwnWindows.judged(layer: layer, owner: own, own: own)) }
    // The windows of other apps at the ordinary level count, and only those.
    XCTAssertTrue(OwnWindows.judged(layer: 0, owner: other, own: own))
    for layer in [3, 25, 1000] { XCTAssertFalse(OwnWindows.judged(layer: layer, owner: other, own: own)) }
    XCTAssertFalse(OwnWindows.judged(layer: nil, owner: other, own: own))
    // A row that names no owner is kept, so that the check of a whole list refuses the list.
    XCTAssertTrue(OwnWindows.judged(layer: 0, owner: nil, own: own))
    // The Accessibility tree that the hands read is never ClawdTime's own.
    XCTAssertEqual(OwnWindows.subject(front: other, menuBar: other, own: own), other)
    XCTAssertEqual(OwnWindows.subject(front: own, menuBar: other, own: own), other)
    XCTAssertNil(OwnWindows.subject(front: own, menuBar: own, own: own))
    XCTAssertNil(OwnWindows.subject(front: own, menuBar: nil, own: own))
    // With no app in front there is no tree to read.
    XCTAssertNil(OwnWindows.subject(front: nil, menuBar: other, own: own))
  }
}
