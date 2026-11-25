import Foundation
import CoreGraphics

public enum PetSide: String, Sendable { case left, right }

/// Where the mascot and the things around it sit on a screen. All of it is plain
/// geometry in screen coordinates (origin at the bottom left), so it is tested with no window.
public enum PetLayout {
  /// The mascot's window at full size. The person scales it with the size slider.
  public static let petSize = CGSize(width: 148, height: 148)
  /// The size slider: the smallest and the largest share of the full size, and where it starts.
  public static let scaleRange = 0.5...1.5, defaultScale = 0.7
  /// A scale that the slider can hold. Anything else, and no number at all, is brought into the range.
  public static func scale(_ value: Double) -> Double {
    value.isFinite ? max(scaleRange.lowerBound, min(scaleRange.upperBound, value)) : defaultScale
  }
  /// The mascot's window for a scale, in whole points.
  public static func size(scale value: Double) -> CGSize {
    let side = (petSize.width * CGFloat(scale(value))).rounded()
    return CGSize(width: side, height: side)
  }
  /// The origin after a change of size: the mascot's middle stays where it is, and it stays on the screen.
  public static func resized(origin: CGPoint, from old: CGSize, to new: CGSize, in visible: CGRect) -> CGPoint {
    clamp(origin: CGPoint(x: origin.x + (old.width - new.width) / 2, y: origin.y + (old.height - new.height) / 2), size: new, in: visible)
  }
  /// How much of the docked mascot shows: at rest, when it wants the person, under the pointer.
  public static let revealResting = 0.40, revealAttention = 0.70, revealHover = 0.88

  public static func clamp(origin: CGPoint, size: CGSize = petSize, in visible: CGRect, margin: CGFloat = 6) -> CGPoint {
    CGPoint(x: max(visible.minX + margin, min(origin.x, visible.maxX - size.width - margin)),
            y: max(visible.minY + margin, min(origin.y, visible.maxY - size.height - margin)))
  }
  /// First start: the right edge, below the top quarter, clear of the menu bar and of most window titles.
  public static func defaultOrigin(in visible: CGRect, size: CGSize = petSize) -> CGPoint {
    clamp(origin: CGPoint(x: visible.maxX - size.width - 28, y: visible.maxY - size.height - visible.height * 0.22), size: size, in: visible)
  }
  /// A position as fractions of the free space, so that it survives a change of screen.
  public static func fraction(origin: CGPoint, in visible: CGRect, size: CGSize = petSize) -> CGPoint {
    let width = max(1, visible.width - size.width), height = max(1, visible.height - size.height)
    return CGPoint(x: max(0, min(1, (origin.x - visible.minX) / width)), y: max(0, min(1, (origin.y - visible.minY) / height)))
  }
  public static func origin(fraction: CGPoint, in visible: CGRect, size: CGSize = petSize) -> CGPoint {
    clamp(origin: CGPoint(x: visible.minX + fraction.x * (visible.width - size.width),
                          y: visible.minY + fraction.y * (visible.height - size.height)), size: size, in: visible)
  }
  public static func nearestSide(frame: CGRect, in visible: CGRect) -> PetSide {
    frame.midX < visible.midX ? .left : .right
  }
  /// A drag that ends against the left or right edge docks there.
  public static func magneticSide(frame: CGRect, in visible: CGRect, threshold: CGFloat = 18) -> PetSide? {
    if frame.minX <= visible.minX + threshold { return .left }
    if frame.maxX >= visible.maxX - threshold { return .right }
    return nil
  }
  /// The docked frame: the mascot hangs over the edge and shows `reveal` of its width.
  public static func docked(side: PetSide, y: CGFloat, reveal: Double, in visible: CGRect, size: CGSize = petSize) -> CGRect {
    let shown = size.width * CGFloat(max(0.2, min(1, reveal)))
    let clampedY = max(visible.minY + 6, min(y, visible.maxY - size.height - 6))
    let x = side == .left ? visible.minX - (size.width - shown) : visible.maxX - shown
    return CGRect(origin: CGPoint(x: x, y: clampedY), size: size)
  }
  /// The panel opens beside the mascot toward the middle of the screen. `anchor` is the
  /// unit point of the panel that is nearest to the mascot: the panel grows from there.
  public static func panel(size: CGSize, pet: CGRect, in visible: CGRect, gap: CGFloat = 8) -> (frame: CGRect, anchor: CGPoint) {
    let below = pet.midY >= visible.midY
    let fitsBeside = pet.minX - gap - size.width >= visible.minX + 8 || pet.maxX + gap + size.width <= visible.maxX - 8
    var frame = CGRect(origin: .zero, size: size)
    if fitsBeside {
      // Beside the mascot, with its top (or bottom) in line with the mascot.
      let left = pet.midX >= visible.midX
      frame.origin.x = left ? pet.minX - gap - size.width : pet.maxX + gap
      frame.origin.y = below ? pet.maxY - size.height : pet.minY
    } else {
      frame.origin.x = pet.midX - size.width / 2
      frame.origin.y = below ? pet.minY - gap - size.height : pet.maxY + gap
    }
    frame.origin.x = max(visible.minX + 8, min(frame.origin.x, visible.maxX - size.width - 8))
    frame.origin.y = max(visible.minY + 8, min(frame.origin.y, visible.maxY - size.height - 8))
    let anchor = CGPoint(x: max(0, min(1, (pet.midX - frame.minX) / size.width)), y: max(0, min(1, (pet.midY - frame.minY) / size.height)))
    return (frame, anchor)
  }
  /// The speech bubble sits above the mascot, or below when there is no room. `tail` is
  /// the x of its pointer inside the bubble.
  /// `clear` is the bar that hangs on the mascot: the bubble goes past it, never over it.
  public static func bubble(size: CGSize, pet: CGRect, in visible: CGRect, gap: CGFloat = 2, clear: CGRect? = nil) -> (frame: CGRect, tail: CGFloat, below: Bool) {
    let shownPet = pet.intersection(visible)
    let centerX = shownPet.isNull ? pet.midX : shownPet.midX
    var top = pet.maxY, bottom = pet.minY
    if let clear, !clear.isEmpty {
      if clear.midY >= pet.midY { top = max(top, clear.maxY + 4) } else { bottom = min(bottom, clear.minY - 4) }
    }
    let above = top + gap + size.height <= visible.maxY - 4
    var frame = CGRect(x: centerX - size.width / 2, y: above ? top + gap : bottom - gap - size.height, width: size.width, height: size.height)
    frame.origin.x = max(visible.minX + 8, min(frame.origin.x, visible.maxX - size.width - 8))
    let tail = max(18, min(size.width - 18, centerX - frame.minX))
    return (frame, tail, !above)
  }
  /// The Stop controls hang under the mascot and never leave the screen.
  public static func controls(size: CGSize, pet: CGRect, in visible: CGRect) -> CGRect {
    var frame = CGRect(x: pet.midX - size.width / 2, y: pet.minY - size.height + 6, width: size.width, height: size.height)
    if frame.minY < visible.minY + 4 { frame.origin.y = pet.maxY - 6 }
    frame.origin.x = max(visible.minX + 8, min(frame.origin.x, visible.maxX - size.width - 8))
    return frame
  }

  /// The close button and the side button stand in one column at the top of the mascot:
  /// the close button on top, the side button just under it.
  public static let buttonDiameter: CGFloat = 26, buttonInset: CGFloat = 4, buttonGap: CGFloat = 6
  /// The side of that column. On a tucked mascot it is the side away from the edge, so the
  /// buttons stay on the screen and leave the edge free. On a free mascot it is the right side.
  public static func buttonSide(docked: PetSide?) -> PetSide {
    docked == .right ? .left : .right
  }
  /// The two buttons at rest, in the mascot's window (origin at its bottom left).
  public static func buttons(size: CGSize, side: PetSide) -> (close: CGRect, side: CGRect) {
    let x = side == .left ? buttonInset : size.width - buttonInset - buttonDiameter
    let close = CGRect(x: x, y: size.height - buttonInset - buttonDiameter, width: buttonDiameter, height: buttonDiameter)
    return (close, close.offsetBy(dx: 0, dy: -(buttonDiameter + buttonGap)))
  }
  /// Where a press reaches the buttons: the two circles and a little room around them, in the window.
  public static func buttonsArea(size: CGSize, side: PetSide) -> CGRect {
    let both = buttons(size: size, side: side)
    return both.close.union(both.side).insetBy(dx: -6, dy: -6).intersection(CGRect(origin: .zero, size: size))
  }
  /// The stone and its ring: an ellipse in the mascot's window, in screen coordinates.
  public static func overStone(pointer: CGPoint, window box: CGRect) -> Bool {
    let dx = (pointer.x - box.midX) / (box.width * 0.42), dy = (pointer.y - (box.midY - 4)) / (box.height * 0.36)
    return dx * dx + dy * dy <= 1
  }
  /// The mascot's window takes a press on the stone, and on the buttons while they show
  /// (`shown` above 0.3). Every other press goes to whatever is behind the mascot.
  public static func takesPress(pointer: CGPoint, window box: CGRect, buttons side: PetSide, shown: Double) -> Bool {
    if overStone(pointer: pointer, window: box) { return true }
    guard shown > 0.3 else { return false }
    return buttonsArea(size: box.size, side: side).offsetBy(dx: box.minX, dy: box.minY).contains(pointer)
  }
}

/// What the mascot says about everything it supervises, in words and in mood.
public struct PetStatus: Equatable, Sendable {
  public struct Bubble: Equatable, Sendable {
    /// Changes when the thing it reports changes, so a dismissed bubble can stay away.
    public let key: String
    public let title: String
    public let detail: String
    /// The one session to bring forward on a click. Nil opens the chat.
    public let sessionId: String?
    /// A request that the person can allow or deny right on the bubble.
    public let decisionId: String?
    /// What ClawdTime heard and what it answered, in a spoken conversation. It may take three lines.
    public let caption: Bool
    /// What the watcher found. Closing the bubble tells the service that the person has seen it.
    public let incidentId: String?
    public init(key: String, title: String, detail: String, sessionId: String?, decisionId: String? = nil, caption: Bool = false,
                incidentId: String? = nil) {
      self.key = key; self.title = title; self.detail = detail; self.sessionId = sessionId; self.decisionId = decisionId
      self.caption = caption; self.incidentId = incidentId
    }
    /// The caption of one spoken turn. It stays longer for a longer answer.
    public static func said(heard: String, reply: String, at: Double) -> (bubble: Bubble, seconds: Double) {
      let words = heard.count > 60 ? String(heard.prefix(57)) + "..." : heard
      return (Bubble(key: "say-\(Int(at))", title: "\u{201C}" + words + "\u{201D}", detail: reply, sessionId: nil, caption: true),
              max(5, min(14, 3 + Double(reply.count) / 16)))
    }
  }
  public let mood: MascotMood
  public let headline: String
  public let detail: String
  public let bubble: Bubble?
  public init(mood: MascotMood, headline: String, detail: String, bubble: Bubble?) {
    self.mood = mood; self.headline = headline; self.detail = detail; self.bubble = bubble
  }

  public static func make(board: AgentBoard?, connected: Bool, taskNeedsPerson: Bool, sharing: Bool,
                          quietSeconds: Double, now: Double, decisions: [PendingDecisions.Request] = [],
                          incidents: [Incidents.Incident] = []) -> PetStatus {
    let sessions = board?.sessions ?? []
    let waiting = sessions.filter { $0.state == .needsYou }
    let working = board?.counts.working ?? 0
    let detail: String
    if !connected { detail = "The task service does not answer." }
    else if board == nil { detail = "The agent board is off." }
    else { detail = sessions.count == 1 ? "1 session on this Mac" : "\(sessions.count) sessions on this Mac" }
    func agents(_ count: Int, _ one: String, _ many: String) -> String { count == 1 ? "1 agent \(one)" : "\(count) agents \(many)" }

    var bubble: Bubble?
    if let request = decisions.first {
      // A request that can be answered here comes before everything else.
      let more = decisions.count > 1 ? "  +\(decisions.count - 1) more" : ""
      bubble = Bubble(key: "decision:" + request.id, title: DecisionText.title(request) + more,
        detail: AgentBoardText.clean(request.summary, limit: 120), sessionId: nil,
        // The bubble offers Approve and Deny only for a request that it shows in full.
        decisionId: request.isQuestion || request.kind == "plan" || request.approvalOnlyInTerminal ? nil : request.id)
    } else if taskNeedsPerson {
      bubble = Bubble(key: "task", title: "Your task needs an answer", detail: "Open the chat to answer.", sessionId: nil)
    } else if waiting.count == 1, let session = waiting.first {
      let time = AgentBoardText.elapsed(since: session.since, now: now)
      bubble = Bubble(key: session.id + ":" + String(Int(session.since ?? 0)), title: AgentBoardText.title(session),
        detail: [AgentBoardText.detail(session.detail), time].filter { !$0.isEmpty }.joined(separator: " · "),
        sessionId: session.canFocus ? session.id : nil)
    } else if waiting.count > 1 {
      let names = waiting.prefix(2).map { AgentBoardText.clean(AgentBoardText.title($0), limit: 22) }.joined(separator: ", ")
      bubble = Bubble(key: waiting.map(\.id).sorted().joined(separator: ","), title: agents(waiting.count, "needs you", "need you"),
        detail: waiting.count > 2 ? names + " and \(waiting.count - 2) more" : names, sessionId: nil)
    } else if let incident = incidents.filter({ $0.kind != "waiting" }).max(by: { $0.raisedAt < $1.raisedAt }) {
      // Nothing waits for the person: the newest thing the watcher found shows. A
      // long wait is not repeated here, because a waiting session has its own bubble above.
      let open = sessions.first { $0.id == incident.sessionId }
      bubble = Bubble(key: "incident:" + incident.id, title: IncidentText.who(incident), detail: IncidentText.detail(incident, now: now),
        sessionId: open?.canFocus == true ? incident.sessionId : nil, incidentId: incident.id)
    }
    let trouble = incidents.filter(\.isTrouble).max(by: { $0.raisedAt < $1.raisedAt })

    let mood: MascotMood, headline: String
    if !connected { mood = .offline; headline = "Not connected" }
    else if sharing { mood = .sharing; headline = "Sharing your screen" }
    else if !decisions.isEmpty {
      mood = .attention
      headline = decisions.count == 1 ? "1 request waits for your answer" : "\(decisions.count) requests wait for your answer"
    }
    else if taskNeedsPerson { mood = .attention; headline = "Your task needs an answer" }
    else if !waiting.isEmpty { mood = .attention; headline = agents(waiting.count, "needs you", "need you") }
    // A session that hangs or died asks for the person's eyes, before the quiet news of work.
    else if let trouble { mood = .attention; headline = IncidentText.headline(trouble) }
    else if working > 0 { mood = .working; headline = agents(working, "at work", "at work") }
    else {
      mood = quietSeconds > 600 ? .asleep : quietSeconds > 180 ? .sleepy : .idle
      headline = sessions.isEmpty ? "No agents yet" : "All quiet"
    }
    return PetStatus(mood: mood, headline: headline, detail: detail, bubble: bubble)
  }
}
