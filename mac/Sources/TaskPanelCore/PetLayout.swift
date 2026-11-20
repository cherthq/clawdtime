import Foundation
import CoreGraphics

public enum PetSide: String, Sendable { case left, right }

/// Where the mascot and the things around it sit on a screen. All of it is plain
/// geometry in screen coordinates (origin at the bottom left), so it is tested with no window.
public enum PetLayout {
  public static let petSize = CGSize(width: 148, height: 148)
  /// How much of the docked mascot shows: at rest, when it wants the person, under the pointer.
  public static let revealResting = 0.40, revealAttention = 0.70, revealHover = 0.88

  public static func clamp(origin: CGPoint, size: CGSize = petSize, in visible: CGRect, margin: CGFloat = 6) -> CGPoint {
    CGPoint(x: max(visible.minX + margin, min(origin.x, visible.maxX - size.width - margin)),
            y: max(visible.minY + margin, min(origin.y, visible.maxY - size.height - margin)))
  }
  /// First start: the right edge, below the top quarter, clear of the menu bar and of most window titles.
  public static func defaultOrigin(in visible: CGRect) -> CGPoint {
    clamp(origin: CGPoint(x: visible.maxX - petSize.width - 28, y: visible.maxY - petSize.height - visible.height * 0.22), in: visible)
  }
  /// A position as fractions of the free space, so that it survives a change of screen.
  public static func fraction(origin: CGPoint, in visible: CGRect) -> CGPoint {
    let width = max(1, visible.width - petSize.width), height = max(1, visible.height - petSize.height)
    return CGPoint(x: max(0, min(1, (origin.x - visible.minX) / width)), y: max(0, min(1, (origin.y - visible.minY) / height)))
  }
  public static func origin(fraction: CGPoint, in visible: CGRect) -> CGPoint {
    clamp(origin: CGPoint(x: visible.minX + fraction.x * (visible.width - petSize.width),
                          y: visible.minY + fraction.y * (visible.height - petSize.height)), in: visible)
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
  public static func docked(side: PetSide, y: CGFloat, reveal: Double, in visible: CGRect) -> CGRect {
    let shown = petSize.width * CGFloat(max(0.2, min(1, reveal)))
    let clampedY = max(visible.minY + 6, min(y, visible.maxY - petSize.height - 6))
    let x = side == .left ? visible.minX - (petSize.width - shown) : visible.maxX - shown
    return CGRect(origin: CGPoint(x: x, y: clampedY), size: petSize)
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
  public static func bubble(size: CGSize, pet: CGRect, in visible: CGRect, gap: CGFloat = 2) -> (frame: CGRect, tail: CGFloat, below: Bool) {
    let shownPet = pet.intersection(visible)
    let centerX = shownPet.isNull ? pet.midX : shownPet.midX
    let above = pet.maxY + gap + size.height <= visible.maxY - 4
    var frame = CGRect(x: centerX - size.width / 2, y: above ? pet.maxY + gap : pet.minY - gap - size.height, width: size.width, height: size.height)
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
}

/// What the mascot says about everything it supervises, in words and in mood.
public struct PetStatus: Equatable, Sendable {
  public struct Bubble: Equatable, Sendable {
    /// Changes when the thing it reports changes, so a dismissed bubble can stay away.
    public let key: String
    public let title: String
    public let detail: String
    /// The one session to bring forward on a click. Nil opens the panel.
    public let sessionId: String?
    public init(key: String, title: String, detail: String, sessionId: String?) {
      self.key = key; self.title = title; self.detail = detail; self.sessionId = sessionId
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
                          quietSeconds: Double, now: Double) -> PetStatus {
    let sessions = board?.sessions ?? []
    let waiting = sessions.filter { $0.state == .needsYou }
    let working = board?.counts.working ?? 0
    let detail: String
    if !connected { detail = "The task service does not answer." }
    else if board == nil { detail = "The agent board is off." }
    else { detail = sessions.count == 1 ? "1 session on this Mac" : "\(sessions.count) sessions on this Mac" }
    func agents(_ count: Int, _ one: String, _ many: String) -> String { count == 1 ? "1 agent \(one)" : "\(count) agents \(many)" }

    var bubble: Bubble?
    if taskNeedsPerson {
      bubble = Bubble(key: "task", title: "Your task needs an answer", detail: "Open the board to answer.", sessionId: nil)
    } else if waiting.count == 1, let session = waiting.first {
      let time = AgentBoardText.elapsed(since: session.since, now: now)
      bubble = Bubble(key: session.id + ":" + String(Int(session.since ?? 0)), title: AgentBoardText.title(session),
        detail: [AgentBoardText.detail(session.detail), time].filter { !$0.isEmpty }.joined(separator: " · "),
        sessionId: session.canFocus ? session.id : nil)
    } else if waiting.count > 1 {
      let names = waiting.prefix(2).map { AgentBoardText.clean(AgentBoardText.title($0), limit: 22) }.joined(separator: ", ")
      bubble = Bubble(key: waiting.map(\.id).sorted().joined(separator: ","), title: agents(waiting.count, "needs you", "need you"),
        detail: waiting.count > 2 ? names + " and \(waiting.count - 2) more" : names, sessionId: nil)
    }

    let mood: MascotMood, headline: String
    if !connected { mood = .offline; headline = "Not connected" }
    else if sharing { mood = .sharing; headline = "Sharing your screen" }
    else if taskNeedsPerson { mood = .attention; headline = "Your task needs an answer" }
    else if !waiting.isEmpty { mood = .attention; headline = agents(waiting.count, "needs you", "need you") }
    else if working > 0 { mood = .working; headline = agents(working, "at work", "at work") }
    else {
      mood = quietSeconds > 600 ? .asleep : quietSeconds > 180 ? .sleepy : .idle
      headline = sessions.isEmpty ? "No agents yet" : "All quiet"
    }
    return PetStatus(mood: mood, headline: headline, detail: detail, bubble: bubble)
  }
}
