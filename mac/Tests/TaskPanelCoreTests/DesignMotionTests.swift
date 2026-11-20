import CoreGraphics
import Foundation
import XCTest
@testable import TaskPanelCore

final class DesignMotionTests: XCTestCase {
  // MARK: design tokens

  func testEveryTextPairPassesContrastInBothThemes() {
    let text: [(ColorToken, ColorToken)] = [
      (.label, .canvas), (.label, .surface), (.label, .raised), (.label, .fill), (.label, .fillPressed),
      (.labelSecondary, .canvas), (.labelSecondary, .surface), (.labelSecondary, .raised), (.labelSecondary, .fill),
      (.onPrimary, .primary), (.onAccent, .accent), (.accentText, .raised), (.accentText, .accentTint),
      (.success, .raised), (.success, .successTint), (.warning, .raised), (.warning, .warningTint),
      (.danger, .raised), (.danger, .dangerTint), (.info, .raised), (.info, .infoTint),
    ]
    for dark in [false, true] {
      for (ink, ground) in text {
        let ratio = RGB.contrast(DesignTokens.value(ink, dark: dark), DesignTokens.value(ground, dark: dark))
        XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(ink.rawValue) on \(ground.rawValue), dark \(dark): \(ratio)")
      }
      // A border that carries meaning needs 3:1.
      XCTAssertGreaterThanOrEqual(RGB.contrast(DesignTokens.value(.borderStrong, dark: dark), DesignTokens.value(.raised, dark: dark)), 3)
    }
    XCTAssertEqual(RGB.contrast(RGB(0x000000), RGB(0xFFFFFF)), 21, accuracy: 0.01)
    XCTAssertEqual(ColorToken.allCases.count, 24)
  }

  // MARK: spring

  func testSpringSettlesOnItsTargetAtAnyFrameRate() {
    for rate in [15.0, 30, 60, 120] {
      var spring = Spring(0, response: MotionToken.settle.response, dampingRatio: MotionToken.settle.dampingRatio)
      spring.target = 1
      var peak = 0.0, steps = 0
      while !spring.settled && steps < 2000 { spring.step(1 / rate); peak = max(peak, spring.value); steps += 1 }
      XCTAssertTrue(spring.settled, "rate \(rate)")
      XCTAssertEqual(spring.value, 1, accuracy: 0.001)
      // The settle token overshoots a little and never rings wildly.
      XCTAssertGreaterThan(peak, 1.01, "rate \(rate)"); XCTAssertLessThan(peak, 1.2, "rate \(rate)")
      XCTAssertLessThan(Double(steps) / rate, 1.2, "settles within about a second at \(rate)")
    }
  }
  func testPressAndSurfaceSpringsDoNotOvershootMuch() {
    var press = Spring(1, response: MotionToken.press.response, dampingRatio: MotionToken.press.dampingRatio)
    press.target = 0.97
    var low = 1.0
    for _ in 0..<120 { press.step(1.0 / 120); low = min(low, press.value) }
    XCTAssertEqual(press.value, 0.97, accuracy: 0.0005); XCTAssertGreaterThan(low, 0.9695)
    var surface = Spring(0, response: MotionToken.surface.response, dampingRatio: MotionToken.surface.dampingRatio)
    surface.target = 1
    var peak = 0.0, reached = -1.0
    for step in 0..<240 { surface.step(1.0 / 120); peak = max(peak, surface.value); if reached < 0 && surface.value >= 0.95 { reached = Double(step) / 120 } }
    XCTAssertLessThan(peak, 1.03)
    XCTAssertLessThan(reached, 0.22, "a surface is 95 percent open within 220 ms")
  }
  func testSpringIgnoresBadStepsAndCanSnap() {
    var spring = Spring(0, response: 0.3, dampingRatio: 0.6)
    spring.target = 1; spring.step(-1); XCTAssertEqual(spring.value, 0)
    spring.step(50); XCTAssertTrue(spring.value.isFinite); XCTAssertLessThan(abs(spring.value), 3)
    spring.snap(to: 0.5); XCTAssertEqual(spring.value, 0.5); XCTAssertEqual(spring.velocity, 0); XCTAssertTrue(spring.settled)
  }

  // MARK: mascot

  func run(_ animator: inout MascotAnimator, _ input: MascotInput, seconds: Double, rate: Double = 60, each: (MascotPose, Double) -> Void = { _, _ in }) {
    var elapsed = 0.0
    while elapsed < seconds { let pose = animator.step(1 / rate, input); elapsed += 1 / rate; each(pose, animator.time) }
  }
  func testTheSameSeedAndStepsGiveTheSamePoses() {
    var a = MascotAnimator(seed: 7), b = MascotAnimator(seed: 7), c = MascotAnimator(seed: 8)
    var posesA: [MascotPose] = [], posesB: [MascotPose] = [], posesC: [MascotPose] = []
    run(&a, MascotInput(mood: .idle), seconds: 12) { pose, _ in posesA.append(pose) }
    run(&b, MascotInput(mood: .idle), seconds: 12) { pose, _ in posesB.append(pose) }
    run(&c, MascotInput(mood: .idle), seconds: 12) { pose, _ in posesC.append(pose) }
    XCTAssertEqual(posesA, posesB); XCTAssertNotEqual(posesA, posesC)
  }
  func testPosesStayInsideWhatTheStoneCanDraw() {
    for mood in MascotMood.allCases {
      var animator = MascotAnimator(seed: 3)
      var input = MascotInput(mood: mood)
      input.pointerActive = true; input.pointerX = 5; input.pointerY = -5; input.hovering = true; input.dragVelocityX = 9000
      for frame in 0..<480 {
        if frame % 97 == 0 { animator.tap() }
        if frame % 131 == 0 { animator.shake(); animator.land() }
        if frame % 173 == 0 { animator.nod() }
        let pose = animator.step(1.0 / 60, input)
        for value in [pose.bob, pose.lift, pose.squash, pose.scale, pose.yaw, pose.pitch, pose.roll, pose.eyeOpen, pose.pupilX, pose.pupilY, pose.glow, pose.sparkAngle, pose.smile] { XCTAssertTrue(value.isFinite) }
        XCTAssertTrue((0...1.4).contains(pose.eyeOpen), "\(mood) eye \(pose.eyeOpen)")
        XCTAssertTrue((-1.05...1.05).contains(pose.pupilX)); XCTAssertTrue((-1.05...1.05).contains(pose.pupilY))
        XCTAssertTrue((0.55...1.5).contains(pose.squash), "\(mood) squash \(pose.squash)")
        XCTAssertTrue((0...1).contains(pose.glow)); XCTAssertTrue(abs(pose.yaw) < 0.9); XCTAssertTrue(abs(pose.roll) < 0.5)
        XCTAssertTrue(pose.sheen == -1 || (0...1).contains(pose.sheen))
      }
    }
  }
  func testItBlinksWhileAwakeAndKeepsItsEyesShutAsleep() {
    var awake = MascotAnimator(seed: 1)
    var closed = 0, frames = 0, blinks = 0, wasClosed = false
    run(&awake, MascotInput(mood: .idle), seconds: 30) { pose, _ in
      frames += 1
      let shut = pose.eyeOpen < 0.15
      if shut { closed += 1 }
      if shut && !wasClosed { blinks += 1 }
      wasClosed = shut
    }
    XCTAssertTrue((5...14).contains(blinks), "\(blinks) blinks in 30 seconds")
    XCTAssertLessThan(Double(closed) / Double(frames), 0.05, "eyes are open nearly all the time")
    var asleep = MascotAnimator(seed: 1)
    var open = 0.0
    run(&asleep, MascotInput(mood: .asleep), seconds: 6) { pose, time in if time > 2 { open = max(open, pose.eyeOpen) } }
    XCTAssertLessThan(open, 0.1)
  }
  func testEyesAndHeadFollowThePointer() {
    var animator = MascotAnimator(seed: 1)
    var input = MascotInput(mood: .idle)
    input.pointerActive = true; input.pointerX = -1; input.pointerY = 1
    var last = MascotPose()
    run(&animator, input, seconds: 1.2) { pose, _ in last = pose }
    XCTAssertLessThan(last.pupilX, -0.9); XCTAssertGreaterThan(last.pupilY, 0.9)
    XCTAssertLessThan(last.yaw, -0.3); XCTAssertLessThan(last.pitch, -0.15)
    input.pointerActive = false
    run(&animator, input, seconds: 1.5) { pose, _ in last = pose }
    XCTAssertEqual(last.pupilX, 0, accuracy: 0.05); XCTAssertEqual(last.yaw, 0, accuracy: 0.05)
  }
  func testAClickPressesTheStoneAndItSpringsBack() {
    var animator = MascotAnimator(seed: 1)
    run(&animator, MascotInput(mood: .idle), seconds: 1)
    animator.tap()
    var low = 1.0, high = 1.0, sheen = false, smiled = 0.0, final = MascotPose()
    run(&animator, MascotInput(mood: .idle), seconds: 1.6, rate: 120) { pose, _ in
      low = min(low, pose.squash); high = max(high, pose.squash); smiled = max(smiled, pose.squint)
      if pose.sheen >= 0 { sheen = true }
      final = pose
    }
    XCTAssertLessThan(low, 0.9, "pressed"); XCTAssertGreaterThan(high, 1.03, "rebound"); XCTAssertEqual(final.squash, 1, accuracy: 0.01)
    XCTAssertTrue(sheen); XCTAssertGreaterThan(smiled, 0.8); XCTAssertEqual(final.squint, 0, accuracy: 0.01)
  }
  func testOnlyAttentionHopsAndTheSparkSpeedIsTheStatus() {
    func survey(_ mood: MascotMood) -> (lift: Double, turned: Double) {
      var animator = MascotAnimator(seed: 2)
      var lift = 0.0, turned = 0.0, previous: Double?
      run(&animator, MascotInput(mood: mood), seconds: 8) { pose, time in
        lift = max(lift, pose.lift)
        if time > 3, let before = previous {
          var delta = pose.sparkAngle - before
          if delta < 0 { delta += 2 * .pi }
          turned += delta
        }
        previous = pose.sparkAngle
      }
      return (lift, turned)
    }
    let idle = survey(.idle), working = survey(.working), attention = survey(.attention), offline = survey(.offline)
    XCTAssertEqual(idle.lift, 0); XCTAssertEqual(working.lift, 0); XCTAssertGreaterThan(attention.lift, 0.2)
    XCTAssertGreaterThan(working.turned, idle.turned * 5); XCTAssertGreaterThan(attention.turned, idle.turned * 2)
    XCTAssertLessThan(offline.turned, 0.05)
  }
  func testReducedMotionKeepsTheStoneStillButTheEyesAlive() {
    var animator = MascotAnimator(seed: 2)
    var input = MascotInput(mood: .attention)
    input.reduceMotion = true; input.pointerActive = true; input.pointerX = 1; input.hovering = true
    animator.tap()
    var blinked = false, last = MascotPose()
    run(&animator, input, seconds: 12) { pose, _ in
      XCTAssertEqual(pose.bob, 0); XCTAssertEqual(pose.lift, 0); XCTAssertEqual(pose.squash, 1); XCTAssertEqual(pose.scale, 1)
      XCTAssertEqual(pose.yaw, 0); XCTAssertEqual(pose.roll, 0); XCTAssertEqual(pose.sheen, -1); XCTAssertEqual(pose.ringWobble, 0)
      if pose.eyeOpen < 0.2 { blinked = true }
      last = pose
    }
    XCTAssertTrue(blinked); XCTAssertGreaterThan(last.pupilX, 0.9)
    XCTAssertEqual(animator.preferredFramesPerSecond(input), 30)
  }
  func testFrameRateFollowsTheMotion() {
    let animator = MascotAnimator(seed: 1)
    XCTAssertEqual(animator.preferredFramesPerSecond(MascotInput(mood: .asleep)), 15)
    XCTAssertEqual(animator.preferredFramesPerSecond(MascotInput(mood: .idle)), 30)
    XCTAssertEqual(animator.preferredFramesPerSecond(MascotInput(mood: .working)), 60)
    var hover = MascotInput(mood: .asleep); hover.hovering = true
    XCTAssertEqual(animator.preferredFramesPerSecond(hover), 60)
  }

  // MARK: where things sit

  let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
  func testFreePositionStaysOnScreenAndSurvivesAScreenChange() {
    let size = PetLayout.petSize
    XCTAssertEqual(PetLayout.clamp(origin: CGPoint(x: -500, y: 5000), in: screen), CGPoint(x: 6, y: 944 - size.height - 6))
    let start = PetLayout.defaultOrigin(in: screen)
    XCTAssertTrue(screen.contains(CGRect(origin: start, size: size)))
    XCTAssertGreaterThan(start.x, screen.midX); XCTAssertGreaterThan(start.y, screen.midY)
    let fraction = PetLayout.fraction(origin: start, in: screen)
    XCTAssertEqual(PetLayout.origin(fraction: fraction, in: screen).x, start.x, accuracy: 0.5)
    let smaller = CGRect(x: 100, y: 50, width: 1000, height: 700)
    XCTAssertTrue(smaller.contains(CGRect(origin: PetLayout.origin(fraction: fraction, in: smaller), size: size)))
  }
  func testDockingHangsTheMascotOverTheEdge() {
    let size = PetLayout.petSize
    let right = PetLayout.docked(side: .right, y: 400, reveal: PetLayout.revealResting, in: screen)
    XCTAssertEqual(right.minX, 1512 - size.width * 0.4, accuracy: 0.01); XCTAssertEqual(right.size, size)
    let left = PetLayout.docked(side: .left, y: 400, reveal: PetLayout.revealAttention, in: screen)
    XCTAssertEqual(left.maxX, size.width * 0.7, accuracy: 0.01)
    XCTAssertGreaterThan(PetLayout.docked(side: .right, y: -90, reveal: 0.4, in: screen).minY, 0)
    XCTAssertEqual(PetLayout.docked(side: .right, y: 400, reveal: 9, in: screen).maxX, 1512, accuracy: 0.01)
    XCTAssertEqual(PetLayout.magneticSide(frame: CGRect(x: 10, y: 300, width: size.width, height: size.height), in: screen), .left)
    XCTAssertEqual(PetLayout.magneticSide(frame: CGRect(x: 1512 - size.width - 4, y: 300, width: size.width, height: size.height), in: screen), .right)
    XCTAssertNil(PetLayout.magneticSide(frame: CGRect(x: 600, y: 300, width: size.width, height: size.height), in: screen))
    XCTAssertEqual(PetLayout.nearestSide(frame: CGRect(x: 200, y: 0, width: 10, height: 10), in: screen), .left)
  }
  func testThePanelOpensBesideTheMascotTowardTheMiddleAndStaysOnScreen() {
    let size = CGSize(width: 392, height: 520)
    let pet = CGRect(origin: PetLayout.defaultOrigin(in: screen), size: PetLayout.petSize)
    let placed = PetLayout.panel(size: size, pet: pet, in: screen)
    XCTAssertEqual(placed.frame.maxX, pet.minX - 8, accuracy: 0.01, "left of a mascot on the right")
    XCTAssertEqual(placed.frame.maxY, pet.maxY, accuracy: 0.01, "top in line with the mascot")
    XCTAssertEqual(placed.anchor.x, 1); XCTAssertGreaterThan(placed.anchor.y, 0.8)
    let low = CGRect(x: 30, y: 20, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
    let other = PetLayout.panel(size: size, pet: low, in: screen)
    XCTAssertEqual(other.frame.minX, low.maxX + 8, accuracy: 0.01); XCTAssertEqual(other.frame.minY, low.minY, accuracy: 0.01)
    XCTAssertEqual(other.anchor.x, 0); XCTAssertLessThan(other.anchor.y, 0.2)
    // A narrow screen has no room beside: the panel goes under or over, and stays inside.
    let narrow = CGRect(x: 0, y: 0, width: 520, height: 900)
    let middle = CGRect(x: 192, y: 700, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
    let stacked = PetLayout.panel(size: size, pet: middle, in: narrow)
    XCTAssertTrue(narrow.contains(stacked.frame)); XCTAssertLessThanOrEqual(stacked.frame.maxY, middle.minY)
    for x in stride(from: -100.0, through: 1500, by: 160) { for y in stride(from: -100.0, through: 900, by: 140) {
      let any = CGRect(x: x, y: y, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
      XCTAssertTrue(screen.contains(PetLayout.panel(size: size, pet: any, in: screen).frame), "pet at \(x),\(y)")
    } }
  }
  func testBubbleAndControlsStayOnScreenAndPointAtTheMascot() {
    let size = CGSize(width: 240, height: 58)
    let pet = CGRect(x: 700, y: 400, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
    let above = PetLayout.bubble(size: size, pet: pet, in: screen)
    XCTAssertFalse(above.below); XCTAssertEqual(above.frame.minY, pet.maxY + 2); XCTAssertEqual(above.tail, 120, accuracy: 0.01)
    let top = CGRect(x: 700, y: 944 - PetLayout.petSize.height - 6, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
    XCTAssertTrue(PetLayout.bubble(size: size, pet: top, in: screen).below)
    // Docked on the right: the bubble moves in and its tail points at the part that shows.
    let docked = PetLayout.docked(side: .right, y: 400, reveal: PetLayout.revealAttention, in: screen)
    let inward = PetLayout.bubble(size: size, pet: docked, in: screen)
    XCTAssertEqual(inward.frame.maxX, 1512 - 8, accuracy: 0.01); XCTAssertGreaterThan(inward.tail, 150)
    let controls = PetLayout.controls(size: CGSize(width: 210, height: 34), pet: pet, in: screen)
    XCTAssertEqual(controls.midX, pet.midX, accuracy: 0.01); XCTAssertLessThan(controls.minY, pet.minY)
    let bottom = CGRect(x: 4, y: 6, width: PetLayout.petSize.width, height: PetLayout.petSize.height)
    let over = PetLayout.controls(size: CGSize(width: 210, height: 34), pet: bottom, in: screen)
    XCTAssertGreaterThanOrEqual(over.minY, bottom.maxY - 6); XCTAssertGreaterThanOrEqual(over.minX, 8)
  }

  // MARK: what the mascot says

  func session(_ id: String, _ state: AgentBoard.State, name: String? = nil, detail: String = "permission_prompt", focus: String = "tab", since: Double? = 1_000_000) -> AgentBoard.Session {
    .init(id: id, agentLabel: "Claude Code", name: name, project: "work", mode: "interactive", state: state, detail: detail,
          since: since, focus: focus, terminal: .init(tty: "ttys001", app: "Terminal", tmux: nil, remote: false))
  }
  func board(_ sessions: [AgentBoard.Session]) -> AgentBoard {
    AgentBoard(version: 1, generatedAt: 1_120_000, intervalMs: 3000,
      counts: .init(needsYou: sessions.filter { $0.state == .needsYou }.count, working: sessions.filter { $0.state == .working }.count,
                    idle: sessions.filter { $0.state == .idle }.count, unknown: sessions.filter { $0.state == .unknown }.count), sessions: sessions)
  }
  func status(_ sessions: [AgentBoard.Session]?, connected: Bool = true, task: Bool = false, sharing: Bool = false, quiet: Double = 0) -> PetStatus {
    PetStatus.make(board: sessions.map(board), connected: connected, taskNeedsPerson: task, sharing: sharing, quietSeconds: quiet, now: 1_120_000)
  }
  func testMoodAndHeadlineSayTheMostUrgentThing() {
    XCTAssertEqual(status(nil, connected: false).mood, .offline); XCTAssertEqual(status(nil, connected: false).headline, "Not connected")
    let one = status([session("1-a", .needsYou, name: "deploy fix"), session("2-a", .working), session("3-a", .idle)])
    XCTAssertEqual(one.mood, .attention); XCTAssertEqual(one.headline, "1 agent needs you"); XCTAssertEqual(one.detail, "3 sessions on this Mac")
    XCTAssertEqual(one.bubble, .init(key: "1-a:1000000", title: "deploy fix", detail: "permission needed · 2m", sessionId: "1-a"))
    let many = status([session("1-a", .needsYou, name: "deploy fix"), session("2-a", .needsYou, name: "docs"), session("3-a", .needsYou, name: "site")])
    XCTAssertEqual(many.headline, "3 agents need you")
    XCTAssertEqual(many.bubble, .init(key: "1-a,2-a,3-a", title: "3 agents need you", detail: "deploy fix, docs and 1 more", sessionId: nil))
    let work = status([session("2-a", .working), session("3-a", .working), session("4-a", .idle)])
    XCTAssertEqual(work.mood, .working); XCTAssertEqual(work.headline, "2 agents at work"); XCTAssertNil(work.bubble)
    XCTAssertEqual(status([session("2-a", .working)]).headline, "1 agent at work")
    XCTAssertEqual(status([session("4-a", .idle)]).headline, "All quiet"); XCTAssertEqual(status([session("4-a", .idle)]).detail, "1 session on this Mac")
    XCTAssertEqual(status([]).headline, "No agents yet")
    XCTAssertEqual(status(nil).detail, "The agent board is off.")
  }
  func testSharingAndTheTaskComeBeforeAgentsAndSleepNeedsQuiet() {
    let waiting = [session("1-a", .needsYou, name: "deploy fix")]
    XCTAssertEqual(status(waiting, sharing: true).mood, .sharing)
    let task = status(waiting, task: true)
    XCTAssertEqual(task.headline, "Your task needs an answer"); XCTAssertEqual(task.bubble?.key, "task"); XCTAssertNil(task.bubble?.sessionId)
    XCTAssertEqual(status([session("4-a", .idle)], quiet: 200).mood, .sleepy)
    XCTAssertEqual(status([session("4-a", .idle)], quiet: 700).mood, .asleep)
    XCTAssertEqual(status([session("2-a", .working)], quiet: 700).mood, .working, "it never sleeps while agents work")
    // A session with no terminal on this Mac cannot be opened from the bubble.
    XCTAssertNil(status([session("bg-1", .needsYou, focus: "none")]).bubble?.sessionId)
  }
}
