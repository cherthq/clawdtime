import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

final class CallPresentationTests: XCTestCase {
  func surface() -> CallPresentationEvent.Surface {
    .init(displayId: "1", width: 1512, height: 982, scale: 2, appId: "com.example.fixture", windowId: "42",
      window: .init(CGRect(x: 20, y: 30, width: 1000, height: 700)))
  }
  func event(_ kind: CallPresentationEvent.Kind = .target) -> CallPresentationEvent {
    .init(producerId: "00000000-0000-4000-8000-000000000001", sequence: 12, commandSeq: 7, at: 1000, kind: kind,
      reducedMotion: true, surface: surface(), target: .init(CGRect(x: 110, y: 240, width: 280, height: 30)))
  }

  func testSharedFixtureMatchesNativeEncoderServiceAndLineContract() throws {
    let fixtureURL = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../tests/fixtures/call-presentation-v1.json").standardizedFileURL
    let fixture = try Data(contentsOf: fixtureURL)
    let decoded = try JSONDecoder().decode(CallPresentationEvent.self, from: fixture)
    try decoded.validate()
    XCTAssertEqual(decoded, event())
    let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: fixture) as? NSDictionary)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(event())) as? NSDictionary)
    XCTAssertEqual(encoded, expected)
  }

  func testPayloadHasOnlyPresentationMetadataAndKeepsRetinaPointsUnscaled() throws {
    let hint = event()
    try hint.validate()
    let bytes = try JSONEncoder().encode(hint)
    let json = try XCTUnwrap(JSONSerialization.jsonObject(with: bytes) as? [String: Any])
    XCTAssertEqual(Set(json.keys), ["version", "producerId", "sequence", "commandSeq", "at", "expiresAt", "kind", "reducedMotion", "surface", "target"])
    let target = try XCTUnwrap(json["target"] as? [String: Double])
    XCTAssertEqual(target, ["x": 110, "y": 240, "w": 280, "h": 30])
    let display = try XCTUnwrap(json["surface"] as? [String: Any])
    XCTAssertEqual(Set(display.keys), ["displayId", "width", "height", "scale", "appId", "windowId", "window"])
    XCTAssertEqual(display["scale"] as? Double, 2)
    XCTAssertEqual(try JSONDecoder().decode(CallPresentationEvent.self, from: bytes), hint)
  }

  func testMissingOrOutOfBoundsTargetDoesNotBecomeAUsableHint() {
    var hint = event(); hint.target = nil
    XCTAssertThrowsError(try hint.validate())
    for rect in [CGRect(x: -1, y: 5, width: 20, height: 20), CGRect(x: 1500, y: 5, width: 20, height: 20),
                 CGRect(x: 5, y: 970, width: 20, height: 20), CGRect(x: 0, y: 0, width: 0, height: 0)] {
      hint.target = .init(rect)
      XCTAssertThrowsError(try hint.validate())
    }
    hint.target = .init(CGRect(x: 0, y: 0, width: 1512, height: 982))
    XCTAssertNoThrow(try hint.validate())
  }

  func testLifetimeAndProducerCommandIdentityAreBounded() {
    var hint = event(); hint.expiresAt = hint.at + 2001
    XCTAssertThrowsError(try hint.validate())
    hint.expiresAt = hint.at
    XCTAssertThrowsError(try hint.validate())
    hint = event(); hint.at = .infinity
    XCTAssertThrowsError(try hint.validate())
    hint = event(); hint.commandSeq = 0
    XCTAssertThrowsError(try hint.validate())
    hint = event(); hint.sequence = 0
    XCTAssertThrowsError(try hint.validate())
    hint = event(); hint.producerId = "window title is not identity"
    XCTAssertThrowsError(try hint.validate())
  }

  func testContextCarriesGeometryOnlyAndRetirementCarriesNoTarget() {
    var hint = event(.context)
    XCTAssertThrowsError(try hint.validate())
    hint.target = nil
    XCTAssertNoThrow(try hint.validate())
    hint.surface = nil
    XCTAssertThrowsError(try hint.validate())
    for kind in [CallPresentationEvent.Kind.reset, .transition] {
      hint.kind = kind
      XCTAssertNoThrow(try hint.validate())
      hint.surface = surface()
      XCTAssertThrowsError(try hint.validate())
      hint.surface = nil
    }
  }

  func testEveryIdentityAndGeometryChangeRetiresTheOldTarget() {
    let original = surface()
    var variants = [CallPresentationEvent.Surface]()
    var next = original; next.displayId = "2"; variants.append(next)
    next = original; next.appId = "com.example.other"; variants.append(next)
    next = original; next.windowId = "43"; variants.append(next)
    next = original; next.window.x += 1; variants.append(next)
    next = original; next.window.w += 1; variants.append(next)
    next = original; next.scale = 1; variants.append(next)
    next = original; next.height += 1; variants.append(next)
    for changed in variants {
      var gate = CallPresentationSurfaceGate()
      XCTAssertTrue(gate.observe(original))
      XCTAssertTrue(gate.observe(original))
      XCTAssertFalse(gate.observe(changed))
      XCTAssertTrue(gate.observe(changed))
      XCTAssertEqual(gate.surface, changed)
    }
  }

  func testMissingSurfaceAndExplicitResetRetirePreviousGeometry() {
    var gate = CallPresentationSurfaceGate()
    XCTAssertTrue(gate.observe(surface()))
    XCTAssertFalse(gate.observe(nil)); XCTAssertNil(gate.surface)
    var invalid = surface(); invalid.window.x = -2
    XCTAssertFalse(gate.observe(invalid)); XCTAssertNil(gate.surface)
    XCTAssertTrue(gate.observe(surface()))
    gate.reset(); XCTAssertNil(gate.surface)
  }

  func testAppAndPossibleDesktopShortcutsWidenWithoutChangingInput() throws {
    for text in ["cmd+tab", "cmd+shift+tab", "cmd+`", "cmd+w", "cmd+m", "cmd+q", "ctrl+cmd+f", "ctrl+left", "ctrl+right", "ctrl+up", "ctrl+down"] {
      let key = try XCTUnwrap(KeyCombo.parse(text))
      XCTAssertTrue(CallPresentationKeyPolicy.mayChangeSurface(key), text)
      XCTAssertEqual(key, KeyCombo.parse(text))
    }
    for text in ["a", "shift+a", "tab", "return", "left", "cmd+s", "cmd+c", "cmd+v"] {
      XCTAssertFalse(CallPresentationKeyPolicy.mayChangeSurface(try XCTUnwrap(KeyCombo.parse(text))), text)
    }
  }

  func testFirstTargetAfterAChangedSurfaceWaitsForStableGeometryThenIsConsumedOnce() throws {
    var gate = CallPresentationSurfaceGate()
    var intent = CallPresentationIntent()
    let original = surface()
    XCTAssertTrue(gate.observe(original))
    var changed = original; changed.windowId = "43"
    XCTAssertFalse(gate.observe(changed))
    let target = try XCTUnwrap(event().target)
    intent.deferTarget(target, on: changed, commandSeq: 7, at: 1000)
    // A widening transition comes first. A later matching observation admits
    // this new action target without using coordinates from the old surface.
    XCTAssertTrue(gate.observe(changed))
    XCTAssertEqual(intent.takeTarget(on: changed, commandSeq: 7, now: 1350), target)
    XCTAssertNil(intent.takeTarget(on: changed, commandSeq: 7, now: 1400))
  }

  func testDeferredTargetCannotSurviveExpiryCommandChangeMovementOrStop() throws {
    let target = try XCTUnwrap(event().target), original = surface()
    var moved = original; moved.window.x += 1
    for (next, seq, now) in [(original, 7, 1901.0), (original, 8, 1350.0), (moved, 7, 1350.0), (original, 7, 999.0)] {
      var intent = CallPresentationIntent()
      intent.deferTarget(target, on: original, commandSeq: 7, at: 1000)
      XCTAssertNil(intent.takeTarget(on: next, commandSeq: seq, now: now))
      // A refused candidate is gone even if geometry later matches again.
      XCTAssertNil(intent.takeTarget(on: original, commandSeq: 7, now: 1400))
    }
    for action in 0..<3 {
      var intent = CallPresentationIntent()
      intent.deferTarget(target, on: original, commandSeq: 7, at: 1000)
      if action == 0 { intent.beginCommand() }
      if action == 1 { intent.geometryChanged() }
      if action == 2 { intent.retire() }
      XCTAssertNil(intent.takeTarget(on: original, commandSeq: 7, now: 1350))
    }
  }

  func testTypingSurvivesGeometryRetirementButNeverReusesItsOldBounds() throws {
    var intent = CallPresentationIntent()
    intent.beginTyping()
    XCTAssertTrue(intent.typing)
    intent.geometryChanged()
    XCTAssertTrue(intent.typing)
    // Only intent survives: no field rectangle can be taken without a new AX
    // read. The native heartbeat takes that read before publishing typing.
    XCTAssertNil(intent.takeTarget(on: surface(), commandSeq: 7, now: 1350))
    intent.endTyping(); XCTAssertFalse(intent.typing)
    intent.beginTyping(); intent.retire(); XCTAssertFalse(intent.typing)
    intent.beginTyping(); intent.beginCommand(); XCTAssertFalse(intent.typing)
  }

  func testTransitionShortcutRetiresTypingAndHasNoDeferredFieldTarget() throws {
    var intent = CallPresentationIntent()
    intent.beginTyping()
    let keys = try XCTUnwrap(KeyCombo.parse("cmd+tab"))
    let changesSurface = CallPresentationKeyPolicy.mayChangeSurface(keys)
    if changesSurface { intent.retire() }
    // Mirrors HandsController: no pointAtKeyboard presentation for this chord.
    if !changesSurface { intent.beginTyping() }
    XCTAssertFalse(intent.typing)
    XCTAssertNil(intent.takeTarget(on: surface(), commandSeq: 7, now: 1350))
  }
}
