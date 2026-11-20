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
    XCTAssertLessThan(low, 0.9, "pressed"); XCTAssertGreaterThan(high, 1.03, "rebound")
    // At rest it still breathes, by a little more than one percent.
    XCTAssertEqual(final.squash, 1, accuracy: 0.02)
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

  // MARK: answers to agents

  func decision(_ id: String = "0123456789abcdef", kind: String = "permission", tool: String = "Bash", summary: String = "npm test",
                options: [String] = [], session: String? = "deploy fix", allowed: Int = 0, denied: Int = 0, hold: Double = 1_045_000) -> PendingDecisions.Request {
    .init(id: id, agentLabel: "Claude Code", kind: kind, tool: tool, summary: summary, options: options, project: "app", session: session,
          sessionId: nil, createdAt: 1_000_000, holdUntil: hold, allowedBefore: allowed, deniedBefore: denied, canRemember: true)
  }
  func testDecisionsDecodeTheServiceContractAndRejectWhatIsOutsideIt() throws {
    let json = #"{"version":1,"away":false,"callReady":true,"pending":[{"id":"0123456789abcdef","agent":"claude-code","agentLabel":"Claude Code","kind":"permission","tool":"Bash","summary":"npm test","options":[],"project":"app","session":null,"sessionId":null,"createdAt":1000,"holdUntil":46000,"allowedBefore":2,"deniedBefore":0,"canRemember":true}]}"#
    let decoded = try JSONDecoder().decode(PendingDecisions.self, from: Data(json.utf8))
    try decoded.validate()
    XCTAssertEqual(decoded.pending.count, 1); XCTAssertTrue(decoded.callReady); XCTAssertFalse(decoded.away)
    XCTAssertNoThrow(try PendingDecisions(version: 1, away: false, callReady: false, pending: [decision()]).validate())
    for bad in [decision("../x"), decision(kind: "other"), decision(summary: String(repeating: "x", count: 601)),
                decision(kind: "question"), decision(hold: 10)] {
      XCTAssertThrowsError(try PendingDecisions(version: 1, away: false, callReady: false, pending: [bad]).validate())
    }
    XCTAssertThrowsError(try PendingDecisions(version: 2, away: false, callReady: false, pending: []).validate())
  }
  func testDecisionTextSaysWhoAsksWhatAndWhatWasAnsweredBefore() {
    XCTAssertEqual(DecisionText.title(decision()), "deploy fix asks to run")
    XCTAssertEqual(DecisionText.title(decision(session: nil)), "Claude Code in app asks to run")
    XCTAssertEqual(DecisionText.title(decision(tool: "Edit")), "deploy fix asks to use Edit")
    XCTAssertEqual(DecisionText.title(decision(kind: "question", options: ["A"])), "deploy fix asks")
    XCTAssertEqual(DecisionText.title(decision(kind: "plan")), "deploy fix has a plan ready")
    XCTAssertEqual(DecisionText.summary(decision(summary: "rm \u{1B}[2J -rf x")), "rm [2J -rf x")
    XCTAssertEqual(DecisionText.history(decision()), "")
    XCTAssertEqual(DecisionText.history(decision(allowed: 1)), "You allowed this once here.")
    XCTAssertEqual(DecisionText.history(decision(allowed: 3)), "You allowed this 3 times here.")
    XCTAssertEqual(DecisionText.history(decision(denied: 2)), "You denied this 2 times here.")
    XCTAssertEqual(DecisionText.history(decision(allowed: 2, denied: 1)), "Here before: allowed 2 times, denied once.")
    XCTAssertEqual(DecisionText.remaining(decision(), now: 1_013_000), "32 s left to answer here")
    XCTAssertEqual(DecisionText.remaining(decision(), now: 2_000_000), "0 s left to answer here")
    XCTAssertEqual(DecisionText.remaining(decision(hold: 1_540_000), now: 1_000_000), "9 min left to answer here")
  }
  func testARequestThatCanBeAnsweredHereComesFirst() {
    let waiting = [session("1-a", .needsYou, name: "deploy fix")]
    let one = PetStatus.make(board: board(waiting), connected: true, taskNeedsPerson: true, sharing: false, quietSeconds: 0, now: 1_120_000, decisions: [decision()])
    XCTAssertEqual(one.mood, .attention); XCTAssertEqual(one.headline, "1 request waits for your answer")
    XCTAssertEqual(one.bubble, .init(key: "decision:0123456789abcdef", title: "deploy fix asks to run", detail: "npm test", sessionId: nil, decisionId: "0123456789abcdef"))
    let two = PetStatus.make(board: nil, connected: true, taskNeedsPerson: false, sharing: false, quietSeconds: 0, now: 0,
                             decisions: [decision(kind: "question", options: ["Red", "Blue"]), decision("fedcba9876543210")])
    XCTAssertEqual(two.headline, "2 requests wait for your answer")
    XCTAssertEqual(two.bubble?.title, "deploy fix asks  +1 more")
    // A question has choices: it is answered on the board, not with two buttons on the bubble.
    XCTAssertNil(two.bubble?.decisionId)
  }

  // MARK: talking to ClawdTime

  func testChatAndVoiceRepliesDecodeTheServiceContract() throws {
    let json = #"{"version":1,"model":true,"speech":true,"voiceDirectory":"/Users/x/.local/share/clawdtime/agents/voice","messages":[{"role":"user","text":"what needs me?","at":1,"via":"voice"},{"role":"assistant","text":"Nothing.","at":2,"via":"voice"}]}"#
    let transcript = try JSONDecoder().decode(ChatTranscript.self, from: Data(json.utf8))
    try transcript.validate()
    XCTAssertEqual(transcript.messages.map(\.mine), [true, false])
    XCTAssertThrowsError(try ChatTranscript(version: 1, model: true, speech: true, voiceDirectory: "relative", messages: []).validate())
    XCTAssertThrowsError(try ChatTranscript(version: 1, model: true, speech: true, voiceDirectory: "/v", messages: [.init(role: "system", text: "x", at: 1, via: "chat")]).validate())
    let reply = try JSONDecoder().decode(VoiceReply.self, from: Data(#"{"heard":"hi","reply":{"role":"assistant","text":"Hello.","at":3,"via":"voice"},"audio":"reply-mabc123.mp3"}"#.utf8))
    XCTAssertEqual(reply.audioName, "reply-mabc123.mp3")
    // A name that is not one the service writes is never played.
    XCTAssertNil(VoiceReply(heard: "", reply: nil, audio: "../../etc/passwd").audioName)
    XCTAssertNil(VoiceReply(heard: "", reply: nil, audio: "reply-x.wav").audioName)
    XCTAssertNil(VoiceReply(heard: "", reply: nil, audio: nil).audioName)
  }
  func testTheMeterRisesFastFallsSlowlyAndStaysInRange() {
    var meter = VoiceMeter()
    for _ in 0..<6 { meter.feed(rms: 0.3) }
    let loud = meter.level
    XCTAssertGreaterThan(loud, 0.8)
    meter.feed(rms: 0); XCTAssertGreaterThan(meter.level, loud * 0.8, "one quiet buffer does not drop the meter")
    for _ in 0..<60 { meter.feed(rms: 0) }
    XCTAssertLessThan(meter.level, 0.01)
    for value in [0.0, 1e-9, 0.5, 1, 5] { meter.feed(rms: value); XCTAssertTrue((0...1).contains(meter.level)) }
    let bars = meter.bars(5, phase: 0.3)
    XCTAssertEqual(bars.count, 5); XCTAssertTrue(bars.allSatisfy { (0.14...1).contains($0) })
    // The bars move on their own, so the shape is read over a full turn of the phase.
    var middle = 0.0, edge = 0.0
    for step in 0..<90 { let frame = meter.bars(5, phase: Double(step) / 90 * 2 * .pi / 7); middle += frame[2]; edge += frame[0] }
    XCTAssertGreaterThan(middle, edge * 1.2, "the middle bar is the tallest")
    meter.rest(); XCTAssertEqual(meter.bars(5, phase: 0), Array(repeating: 0.14, count: 5))
  }
  func testOneSentenceStartsOnSpeechAndEndsOnAPause() {
    var activity = VoiceActivity()
    var events: [VoiceActivity.Event] = []
    func feed(_ level: Double, _ seconds: Double) { var left = seconds; while left > 0 { let event = activity.feed(level: level, seconds: 0.02); if event != .none { events.append(event) }; left -= 0.02 } }
    feed(0.05, 1); XCTAssertEqual(events, []); XCTAssertFalse(activity.speaking)
    feed(0.6, 0.06); feed(0.05, 0.1); XCTAssertEqual(events, [], "a click is not speech")
    feed(0.6, 0.2); XCTAssertEqual(events, [.started])
    feed(0.05, 0.6); feed(0.6, 0.4); XCTAssertEqual(events, [.started], "a short pause inside a sentence does not end it")
    feed(0.05, 1.2); XCTAssertEqual(events.first, .started); XCTAssertEqual(events.last, .ended)
    // Silence only: the recording is thrown away after six seconds.
    activity.reset(); events = []
    feed(0.02, 6.2); XCTAssertEqual(events.first, .discard)
    // Talk that never stops is cut at half a minute.
    activity.reset(); events = []
    feed(0.7, 31); XCTAssertEqual(events.first, .started); XCTAssertTrue(events.contains(.ended))
  }
  func testAVoiceLightsTheSparkAndOpensTheMouth() {
    var animator = MascotAnimator(seed: 4)
    var quiet = MascotInput(mood: .idle), loud = MascotInput(mood: .idle)
    loud.voice = 0.9; quiet.voice = 0
    var silent = MascotPose(), spoken = MascotPose()
    for _ in 0..<60 { silent = animator.step(1.0 / 60, quiet) }
    for _ in 0..<30 { spoken = animator.step(1.0 / 60, loud) }
    XCTAssertGreaterThan(spoken.glow, 0.85); XCTAssertGreaterThan(spoken.smile, silent.smile + 0.3)
    XCTAssertEqual(animator.preferredFramesPerSecond(loud), 60)
  }
  func testEveryMascotStyleHasANameAndTheClockStopsUnderReducedMotion() {
    XCTAssertEqual(MascotStyle.allCases.map(\.rawValue), ["flint", "jet", "jade", "lapis", "amber", "garnet", "amethyst", "pebble", "core", "neon", "iris"])
    XCTAssertEqual(MascotStyle.allCases.first, .flint, "a new install starts with the Chert mark")
    XCTAssertEqual(Set(MascotStyle.allCases.map(\.title)).count, 11)
    XCTAssertTrue(MascotStyle.allCases.allSatisfy { !$0.summary.isEmpty && $0.summary.count < 60 })
    var animator = MascotAnimator(seed: 2)
    var moving = MascotInput(mood: .working), still = MascotInput(mood: .working)
    moving.voice = 0.5; still.reduceMotion = true
    var pose = MascotPose()
    for _ in 0..<30 { pose = animator.step(1.0 / 60, moving) }
    XCTAssertEqual(pose.clock, 0.5, accuracy: 0.001); XCTAssertEqual(pose.voice, 0.5)
    pose = animator.step(1.0 / 60, still)
    XCTAssertEqual(pose.clock, 0, "a style that moves on its own stops under reduced motion")
  }
  func testARemovedStyleNoLongerReads() {
    // A style that was removed no longer reads, so a kept choice of it falls back to the mark.
    for old in ["orb", "onyx", "flux"] { XCTAssertNil(MascotStyle(rawValue: old)) }
  }
  func testTheSizeSliderStartsSmallAndStaysInItsRange() {
    // The start size is smaller than the full size, and it is a place on the slider.
    XCTAssertLessThan(PetLayout.defaultScale, 1)
    XCTAssertTrue(PetLayout.scaleRange.contains(PetLayout.defaultScale))
    XCTAssertEqual(PetLayout.size(scale: 1), PetLayout.petSize)
    XCTAssertEqual(PetLayout.size(scale: PetLayout.defaultScale).width, 104, accuracy: 0.01)
    // Outside the range, and with no number at all, the size is still a usable one.
    XCTAssertEqual(PetLayout.size(scale: 0.01), PetLayout.size(scale: 0.5))
    XCTAssertEqual(PetLayout.size(scale: 40), PetLayout.size(scale: 1.5))
    XCTAssertEqual(PetLayout.size(scale: .nan), PetLayout.size(scale: PetLayout.defaultScale))
    XCTAssertEqual(PetLayout.size(scale: -.infinity), PetLayout.size(scale: PetLayout.defaultScale))
    // Whole points, and always a square.
    for step in 0...100 {
      let size = PetLayout.size(scale: 0.5 + Double(step) / 100)
      XCTAssertEqual(size.width, size.height)
      XCTAssertEqual(size.width, size.width.rounded())
    }
  }
  func testAChangeOfSizeKeepsTheMiddleAndStaysOnTheScreen() {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    let full = PetLayout.petSize, small = PetLayout.size(scale: 0.5), large = PetLayout.size(scale: 1.5)
    let origin = CGPoint(x: 600, y: 400)
    let shrunk = PetLayout.resized(origin: origin, from: full, to: small, in: screen)
    XCTAssertEqual(shrunk.x + small.width / 2, origin.x + full.width / 2, accuracy: 0.01)
    XCTAssertEqual(shrunk.y + small.height / 2, origin.y + full.height / 2, accuracy: 0.01)
    // There and back is the same place.
    let back = PetLayout.resized(origin: shrunk, from: small, to: full, in: screen)
    XCTAssertEqual(back.x, origin.x, accuracy: 0.01); XCTAssertEqual(back.y, origin.y, accuracy: 0.01)
    // In a corner, a larger mascot moves in and never leaves the screen.
    let corner = CGPoint(x: screen.maxX - small.width - 6, y: screen.maxY - small.height - 6)
    let grown = CGRect(origin: PetLayout.resized(origin: corner, from: small, to: large, in: screen), size: large)
    XCTAssertTrue(screen.contains(grown))
  }
  func testEveryPlaceRuleHoldsForASmallAndALargeMascot() {
    let screen = CGRect(x: 0, y: 0, width: 1512, height: 944)
    for scale in [0.5, 0.7, 1.0, 1.5] {
      let size = PetLayout.size(scale: scale)
      let start = PetLayout.defaultOrigin(in: screen, size: size)
      XCTAssertTrue(screen.contains(CGRect(origin: start, size: size)), "\(scale)")
      // A place survives a change of screen, at this size.
      let fraction = PetLayout.fraction(origin: start, in: screen, size: size)
      XCTAssertEqual(PetLayout.origin(fraction: fraction, in: screen, size: size).x, start.x, accuracy: 0.5)
      // Tucked, it shows the same share of its own width.
      let docked = PetLayout.docked(side: .right, y: 400, reveal: PetLayout.revealResting, in: screen, size: size)
      XCTAssertEqual(docked.size, size)
      XCTAssertEqual(screen.maxX - docked.minX, size.width * CGFloat(PetLayout.revealResting), accuracy: 0.01)
      let left = PetLayout.docked(side: .left, y: 2000, reveal: PetLayout.revealResting, in: screen, size: size)
      XCTAssertEqual(left.maxX - screen.minX, size.width * CGFloat(PetLayout.revealResting), accuracy: 0.01)
      XCTAssertLessThanOrEqual(left.maxY, screen.maxY - 6)
    }
  }
  func testTheBubbleGoesPastTheBarAndNeverOverIt() {
    let screen = CGRect(x: 0, y: 0, width: 1440, height: 900), size = CGSize(width: 207, height: 62)
    // Near the top of the screen the bubble is under the mascot, and so is the bar.
    let top = CGRect(x: 1280, y: 740, width: 148, height: 148)
    let bar = PetLayout.controls(size: CGSize(width: 86, height: 40), pet: top, in: screen)
    let under = PetLayout.bubble(size: size, pet: top, in: screen, clear: bar)
    XCTAssertTrue(under.below); XCTAssertFalse(under.frame.intersects(bar)); XCTAssertLessThanOrEqual(under.frame.maxY, bar.minY - 4)
    XCTAssertTrue(PetLayout.bubble(size: size, pet: top, in: screen).frame.intersects(bar), "without the bar in mind they would overlap")
    // In the middle the bubble is above and the bar is below: nothing changes.
    let middle = CGRect(x: 600, y: 400, width: 148, height: 148)
    let low = PetLayout.controls(size: CGSize(width: 86, height: 40), pet: middle, in: screen)
    XCTAssertEqual(PetLayout.bubble(size: size, pet: middle, in: screen, clear: low).frame, PetLayout.bubble(size: size, pet: middle, in: screen).frame)
    // At the bottom edge the bar goes over the mascot, and the bubble goes over the bar.
    let bottom = CGRect(x: 600, y: 4, width: 148, height: 148)
    let high = PetLayout.controls(size: CGSize(width: 86, height: 40), pet: bottom, in: screen)
    XCTAssertGreaterThan(high.minY, bottom.midY)
    let over = PetLayout.bubble(size: size, pet: bottom, in: screen, clear: high)
    XCTAssertFalse(over.below); XCTAssertFalse(over.frame.intersects(high)); XCTAssertGreaterThanOrEqual(over.frame.minY, high.maxY + 4)
  }
  func testASpokenTurnBecomesACaptionThatStaysLongerForALongerAnswer() {
    let short = PetStatus.Bubble.said(heard: "what needs me", reply: "Nothing.", at: 1795170939254)
    XCTAssertTrue(short.bubble.caption); XCTAssertEqual(short.bubble.title, "\u{201C}what needs me\u{201D}"); XCTAssertEqual(short.bubble.detail, "Nothing.")
    XCTAssertEqual(short.bubble.key, "say-1795170939254"); XCTAssertNil(short.bubble.sessionId); XCTAssertNil(short.bubble.decisionId)
    XCTAssertEqual(short.seconds, 5)
    let long = PetStatus.Bubble.said(heard: String(repeating: "word ", count: 30), reply: String(repeating: "a", count: 400), at: 2)
    XCTAssertEqual(long.seconds, 14); XCTAssertLessThanOrEqual(long.bubble.title.count, 62)
    XCTAssertFalse(PetStatus.Bubble(key: "k", title: "t", detail: "d", sessionId: nil).caption)
  }

  // MARK: the body has weight

  private let room = BodyPhysics.Bounds(minX: 0, minY: 0, maxX: 1000, maxY: 800)

  func testAHeldBodyLagsTheHandThenReachesIt() {
    var body = BodyPhysics(x: 100, y: 100)
    body.hold(x: 400, y: 100)
    var frame = body.step(1.0 / 60, bounds: room)
    XCTAssertGreaterThan(frame.x, 100); XCTAssertLessThan(frame.x, 300, "it does not jump to the hand")
    var furthest = frame.x
    for _ in 0..<90 { frame = body.step(1.0 / 60, bounds: room); furthest = max(furthest, frame.x) }
    XCTAssertEqual(frame.x, 400, accuracy: 0.5); XCTAssertEqual(frame.y, 100, accuracy: 0.5)
    XCTAssertGreaterThan(furthest, 401, "a little past the hand, then back: it has weight")
    XCTAssertLessThan(furthest, 440)
    XCTAssertTrue(frame.moving, "held is never at rest")
  }
  func testAPullSwingsTheBodyBackAndTheSwingDiesOut() {
    var body = BodyPhysics(x: 100, y: 300)
    var lowest = 0.0, highest = 0.0
    // The hand goes to the right, fast, for a fifth of a second, then stops.
    for step in 0..<12 { body.hold(x: 100 + Double(step + 1) * 30, y: 300); let frame = body.step(1.0 / 60, bounds: room); lowest = min(lowest, frame.swing); highest = max(highest, frame.swing) }
    XCTAssertLessThan(lowest, -0.10, "pulled to the right, the base stays behind")
    var last = BodyPhysics.Frame()
    for _ in 0..<150 { last = body.step(1.0 / 60, bounds: room); lowest = min(lowest, last.swing); highest = max(highest, last.swing) }
    XCTAssertGreaterThan(highest, 0.05, "it swings through to the other side")
    XCTAssertEqual(last.swing, 0, accuracy: 0.01); XCTAssertGreaterThanOrEqual(lowest, -0.85)
  }
  func testAThrowFliesSlowsBouncesOffTheEdgeAndRests() {
    var body = BodyPhysics(x: 600, y: 400)
    for step in 0..<10 { body.hold(x: 600 + Double(step + 1) * 26, y: 400); _ = body.step(1.0 / 60, bounds: room) }
    body.letGo()
    XCTAssertGreaterThan(body.vx, 900, "it leaves the hand at the hand's speed")
    var impacts: [Double] = [], frames = 0, last = BodyPhysics.Frame(), turned = false
    repeat {
      last = body.step(1.0 / 60, bounds: room); frames += 1
      if last.impact > 0 { impacts.append(last.impact) }
      if body.vx < 0 { turned = true }
      XCTAssertLessThanOrEqual(last.x, 1000); XCTAssertGreaterThanOrEqual(last.x, 0)
    } while last.moving && frames < 600
    XCTAssertEqual(impacts.count, 1, "one hit on the right edge"); XCTAssertGreaterThan(impacts[0], 0.2)
    XCTAssertTrue(turned, "it came back from the edge")
    XCTAssertLessThan(frames, 300, "at rest within five seconds"); XCTAssertFalse(last.moving)
    XCTAssertEqual(last.swing, 0); XCTAssertEqual(last.stretch, 0); XCTAssertEqual(last.gait, 0)
    XCTAssertLessThan(last.x, 1000)
  }
  func testSpeedStretchesTheBodyAlongItsWayAndGivesItACadence() {
    var body = BodyPhysics(x: 800, y: 100)
    var frame = BodyPhysics.Frame(), phases: Set<Int> = []
    // To the left and a little up, fast.
    for step in 0..<30 { body.hold(x: 800 - Double(step + 1) * 20, y: 100 + Double(step + 1) * 4); frame = body.step(1.0 / 60, bounds: room); phases.insert(Int(frame.gaitPhase)) }
    XCTAssertGreaterThan(frame.stretch, 0.2); XCTAssertLessThanOrEqual(frame.stretch, 0.26)
    XCTAssertEqual(frame.stretchAngle, atan2(4, -20), accuracy: 0.12)
    XCTAssertLessThan(frame.travel, -0.8); XCTAssertGreaterThan(frame.gait, 0.8)
    XCTAssertGreaterThan(phases.count, 2, "the cadence turns while it runs")
    for _ in 0..<240 { frame = body.step(1.0 / 60, bounds: room) }
    XCTAssertEqual(frame.stretch, 0, accuracy: 0.004); XCTAssertEqual(frame.gait, 0, accuracy: 0.02); XCTAssertEqual(frame.travel, 0, accuracy: 0.02)
  }
  func testADropAtRestStaysAndReducedMotionFollowsTheHandExactly() {
    var body = BodyPhysics(x: 300, y: 300)
    body.hold(x: 300, y: 300); _ = body.step(1.0 / 60, bounds: room); body.letGo()
    var frame = body.step(1.0 / 60, bounds: room)
    for _ in 0..<30 { frame = body.step(1.0 / 60, bounds: room) }
    XCTAssertFalse(frame.moving); XCTAssertEqual(frame.x, 300, accuracy: 0.01)
    var calm = BodyPhysics(x: 0, y: 0)
    calm.hold(x: 420, y: 77)
    let still = calm.step(1.0 / 60, bounds: room, still: true)
    XCTAssertEqual(still.x, 420); XCTAssertEqual(still.y, 77); XCTAssertEqual(still.swing, 0); XCTAssertEqual(still.stretch, 0); XCTAssertEqual(still.gait, 0)
    calm.letGo()
    XCTAssertFalse(calm.step(1.0 / 60, bounds: room, still: true).moving)
    // A place outside the screen comes back inside.
    calm.place(x: 5000, y: -50)
    let inside = calm.step(1.0 / 60, bounds: room, still: true)
    XCTAssertEqual(inside.x, 1000); XCTAssertEqual(inside.y, 0)
  }
  func testAClickIsARealJumpWithACrouchAFlightAndALanding() {
    var animator = MascotAnimator(seed: 3)
    let input = MascotInput(mood: .idle)
    for _ in 0..<30 { _ = animator.step(1.0 / 60, input) }
    animator.jump()
    var crouch = 1.0, top = 0.0, air = 0.0, long = 1.0, landing = 1.0, last = MascotPose()
    for frame in 0..<120 {
      last = animator.step(1.0 / 60, input)
      let t = Double(frame + 1) / 60
      if t <= 0.12 { crouch = min(crouch, last.squash); XCTAssertEqual(last.lift, 0, "it crouches before it leaves the ground") }
      else if t < 0.55 { top = max(top, last.lift); air = max(air, last.air); long = max(long, last.squash) }
      else if t < 0.9 { landing = min(landing, last.squash) }
    }
    XCTAssertLessThan(crouch, 0.86); XCTAssertGreaterThan(top, 0.42); XCTAssertGreaterThan(air, 0.95)
    XCTAssertGreaterThan(long, 1.08, "long in the air"); XCTAssertLessThan(landing, 0.93, "it lands with weight")
    XCTAssertEqual(last.lift, 0); XCTAssertEqual(last.air, 0); XCTAssertEqual(last.squash, 1, accuracy: 0.04)
    // Reduced motion: no jump at all.
    var calm = MascotAnimator(seed: 3); var still = MascotInput(mood: .idle); still.reduceMotion = true
    calm.jump()
    for _ in 0..<40 { let pose = calm.step(1.0 / 60, still); XCTAssertEqual(pose.lift, 0); XCTAssertEqual(pose.squash, 1) }
  }
  func testAWaveRocksTheBodyAndTheBodyActsOutItsTravel() {
    var animator = MascotAnimator(seed: 5)
    var input = MascotInput(mood: .idle)
    for _ in 0..<30 { _ = animator.step(1.0 / 60, input) }
    animator.wave()
    var rock = 0.0, raised = 0.0, sides: Set<Bool> = []
    for _ in 0..<57 { let pose = animator.step(1.0 / 60, input); rock = max(rock, abs(pose.roll)); raised = max(raised, pose.wave); if abs(pose.roll) > 0.05 { sides.insert(pose.roll > 0) } }
    XCTAssertGreaterThan(rock, 0.12); XCTAssertGreaterThan(raised, 0.95); XCTAssertEqual(sides.count, 2, "to both sides")
    for _ in 0..<30 { _ = animator.step(1.0 / 60, input) }
    XCTAssertEqual(animator.step(1.0 / 60, input).wave, 0)
    // Carried to the right at a run, with the base hanging back.
    input.held = true; input.gait = 1; input.travel = 1; input.swing = -0.3
    var strides: Set<Bool> = [], pose = MascotPose(), wide = 0.0, steps = 0, before = 0.0, rising = false
    for frame in 0..<60 {
      input.gaitPhase = Double(frame) * 0.23
      pose = animator.step(1.0 / 60, input)
      if abs(pose.stride) > 0.3 { strides.insert(pose.stride > 0) }
      // Each step is one rise and one fall of the body.
      if frame > 0 { let up = pose.bob > before; if up && !rising { steps += 1 }; rising = up }
      before = pose.bob
      if frame < 12 { wide = max(wide, pose.eyeOpen) }
    }
    XCTAssertGreaterThan(pose.yaw, 0.35, "it faces the way it goes"); XCTAssertLessThan(pose.roll, -0.2)
    XCTAssertEqual(pose.gait, 1); XCTAssertEqual(pose.travel, 1); XCTAssertTrue(pose.held)
    XCTAssertEqual(strides.count, 2, "its steps alternate"); XCTAssertGreaterThanOrEqual(steps, 3, "it bobs with its steps")
    XCTAssertGreaterThan(wide, 1.2, "picked up: wide eyes for a moment")
    input.reduceMotion = true
    let calm = animator.step(1.0 / 60, input)
    XCTAssertEqual(calm.gait, 0); XCTAssertEqual(calm.roll, 0); XCTAssertEqual(calm.bob, 0)
  }
  func testMemoryShowsOnARequestAndInTheChatOnlyWhenTheServiceSaysSo() throws {
    func request(_ recalled: String?) -> PendingDecisions.Request {
      PendingDecisions.Request(id: "0123456789abcdef", agentLabel: "Claude Code", kind: "permission", tool: "Bash", summary: "git push origin main",
        options: [], project: "app", session: nil, sessionId: nil, createdAt: 1, holdUntil: 2, allowedBefore: 0, deniedBefore: 0, canRemember: true, recalled: recalled)
    }
    XCTAssertEqual(DecisionText.said(request("Never force push to main.")), "You said: Never force push to main.")
    XCTAssertEqual(DecisionText.said(request(nil)), "")
    XCTAssertEqual(DecisionText.said(request("  \u{1B} ")), "")
    XCTAssertThrowsError(try PendingDecisions(version: 1, away: false, callReady: false, pending: [request(String(repeating: "x", count: 401))]).validate())
    // A service with memory off, or an older one, sends no such field.
    let json = #"{"version":1,"away":false,"callReady":false,"pending":[{"id":"0123456789abcdef","agentLabel":"Claude Code","kind":"permission","tool":"Bash","summary":"npm test","options":[],"project":"app","session":null,"sessionId":null,"createdAt":1,"holdUntil":2,"allowedBefore":0,"deniedBefore":0,"canRemember":true}]}"#
    XCTAssertNil(try JSONDecoder().decode(PendingDecisions.self, from: Data(json.utf8)).pending[0].recalled)
    let filled = json.replacingOccurrences(of: #""canRemember":true"#, with: #""canRemember":true,"recalled":"Use pnpm here.""#)
    let decoded = try JSONDecoder().decode(PendingDecisions.self, from: Data(filled.utf8))
    try decoded.validate()
    XCTAssertEqual(decoded.pending[0].recalled, "Use pnpm here.")
    let on = try JSONDecoder().decode(ChatTranscript.self, from: Data(#"{"version":1,"model":true,"speech":false,"voiceDirectory":"/v","memory":true,"messages":[]}"#.utf8))
    XCTAssertEqual(on.memory, true)
    let older = try JSONDecoder().decode(ChatTranscript.self, from: Data(#"{"version":1,"model":true,"speech":false,"voiceDirectory":"/v","messages":[]}"#.utf8))
    XCTAssertNil(older.memory)
  }
}
