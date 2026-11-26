import Foundation

/// Each sequence number is run once and answered once. A number that comes
/// again is never run again: the worker reads a missing answer as an unknown
/// outcome, and a second run would repeat an effect on the person's Mac.
public struct HandsLedger: Equatable, Sendable {
  /// The highest sequence number that the hands took. It is the `after` of the next read.
  public private(set) var last = 0
  private var instance: String?
  public init() {}
  /// True once for each number, in rising order.
  public mutating func claim(_ seq: Int) -> Bool {
    guard seq > last else { return false }
    last = seq
    return true
  }
  /// The task service that answers now. Another instance counts from the start again.
  public mutating func service(_ id: String) {
    if let instance, instance != id { last = 0 }
    instance = id
  }
}

/// Stop, as the hands keep it. After the person stops a run, a command that
/// waits is answered and not run. The next run starts free.
public struct HandsStop: Equatable, Sendable {
  public private(set) var stopped = false
  public init() {}
  public mutating func press() { stopped = true }
  /// What the service says about the run. Only the end of the run lifts Stop.
  public mutating func observe(active: Bool) { if !active { stopped = false } }
}

/// The last check before an event of the hands goes out. The guided cursor took
/// a moment to reach the place, and in that moment the person can have stopped
/// the work or taken the mouse. So the check comes after the glide, as late as
/// it can.
public enum HandsGate {
  /// Nil: the event may go. Otherwise nothing is sent, and this is what the worker hears.
  /// - `stopped`: Stop on the bar, or Escape held, at this Mac.
  /// - `watching` and `personActed`: the tap listens, and the person moved the mouse or pressed
  ///   a key since the command began. What the worker checked may be another place now, so the
  ///   worker pauses and asks.
  /// - `run`: what the service says now, read just before the event. Nil when it did not
  ///   answer. A stop that came through the chat, a call or the panel shows here as `stopping`.
  /// - `keyboardHidden`: macOS guards the keyboard (Secure Event Input), as it does for a password field. The tap
  ///   then sees none of the person's keys, and so no Escape held for Stop either. The person counts as one who
  ///   holds the keyboard: nothing is sent, whatever the kind of input, and the worker asks.
  public static func refusal(stopped: Bool, watching: Bool, personActed: Bool, keyboardHidden: Bool = false, run: HandsNext.Run?) -> HandError? {
    if stopped { return .stoppedByPerson }
    if watching && personActed { return .refused }
    if keyboardHidden { return .refused }
    // With no word from the service nothing is sent: its result could not be posted either.
    guard let run else { return .failed }
    if run.state == "stopping" { return .stoppedByPerson }
    // Only a request that runs may act. One that ended or waits for the person sends nothing.
    return run.active && run.state == "running" ? nil : .refused
  }
  /// The result says that the person took the Mac: the worker then pauses and asks. Without the tap nobody
  /// listened, so nothing is said about the person.
  public static func interrupted(watching: Bool, personActed: Bool, keyboardHidden: Bool) -> Bool {
    watching && (personActed || keyboardHidden)
  }
  /// What the bar says while the hands wait because macOS guards the keyboard.
  public static let keyboardHiddenDetail = "macOS guards the keyboard, as for a password. ClawdTime cannot see your keys now, so it waits for you."
}

/// What the person did with the mouse and the keys, as the hands keep it between commands. Times are seconds of
/// one clock, such as the system uptime.
///
/// The worker plans each input from a look. What the person does after that look, also between two commands,
/// counts for the input: the screen may not be what the worker saw. So a command that sends input starts with
/// the person's input since the start of the last look that gave the screen, and a look starts clean. A command
/// that sends nothing (a wait, a closer picture) says only what happened during it.
public struct HandsOwnerWatch: Equatable, Sendable {
  /// The person acted during this command, or, for a command that sends input, after the look that it rests on.
  public private(set) var acted = false
  /// When the person last moved the mouse or pressed a key.
  private var lastInput: Double?
  /// When the last look that gave the screen began.
  private var lookBegan: Double?
  public init() {}
  /// The person moved the mouse or pressed a key at `time`.
  public mutating func saw(at time: Double) {
    acted = true
    lastInput = max(lastInput ?? time, time)
  }
  /// A command begins at `time`. `input`: it sends input to the Mac, so it rests on the last look.
  public mutating func begin(at time: Double, input: Bool) { acted = input && actedSinceLook }
  /// The command that began at `time` gave a look of the screen.
  public mutating func looked(began time: Double) { lookBegan = max(lookBegan ?? time, time) }
  /// The person acted at or after the start of the last look, or acted with no look at all.
  private var actedSinceLook: Bool {
    guard let lastInput else { return false }
    guard let lookBegan else { return true }
    return lastInput >= lookBegan
  }
  /// The tap stopped listening: what it saw before says nothing about later.
  public mutating func forget() { self = HandsOwnerWatch() }
}

/// How often the hands ask for the next command.
///
/// A service that holds a read (it answers with `HandsPace.heldHeader`) answers as soon as a command
/// waits, or when what runs changes, or after `hold`. The hands then read again at once: no command
/// waits for the next read. A service that answers at once is read at the old pace.
public enum HandsPace {
  /// Seconds between the starts of two reads while the worker runs, and while it does not, at a service
  /// that answers at once. The idle time is what a new request waits before the hands see it.
  public static let active = 0.12, idle = 0.25
  /// The longest time that one read waits at the service for a command. It is well under the time limit
  /// of one request of the panel (4 seconds), so a held read never counts as a service that is gone.
  public static let hold = 1.0
  /// The shortest time between the starts of two reads, also at a service that holds them: a service that
  /// says that it holds a read and still answers at once is never read more often than this.
  public static let shortestGap = 0.02
  /// The header with which a service says that it held the read.
  public static let heldHeader = "X-ClawdTime-Hands-Wait"
  /// The header with which a service says that a call shows the screen now: its value is `call`.
  public static let screenShownHeader = "X-ClawdTime-Screen-Shown"
  /// The wait before the next read. `elapsed` is how long the last read took, `held` says that the service
  /// held it, and `ran` that the hands just ran a command and posted its result. A service that does not
  /// answer is asked less often.
  public static func delay(active: Bool, failures: Int, elapsed: Double = 0, held: Bool = false, ran: Bool = false) -> Double {
    if failures > 0 { return min(5, pow(2, Double(min(failures, 4) - 1))) }
    let spent = elapsed.isFinite ? max(0, elapsed) : 0
    // The service waits for the next command itself.
    if held { return max(0, shortestGap - spent) }
    // The next command of a step usually comes a moment after a result: one read at once.
    if ran { return 0 }
    return max(0, (active ? Self.active : idle) - spent)
  }
  /// After this many reads with no answer, the bar goes: nothing can command the hands.
  public static let failuresBeforeQuiet = 3
}

/// What one command cost the hands, for the timing of a step: whole milliseconds and bytes, nothing of
/// the screen. Nil is a part that the command did not have. The panel sends it with the result, in a
/// header that a service which does not know it leaves alone.
public struct HandsCost: Equatable, Sendable {
  /// Taking the picture, and writing it as a JPEG with its base64.
  public var captureMs: Int?, encodeMs: Int?
  /// The bytes of the JPEG.
  public var imageBytes: Int?
  /// The walk of the Accessibility tree.
  public var walkMs: Int?
  /// The Vision OCR fallback when the Accessibility tree is sparse.
  public var ocrMs: Int?
  /// The guided cursor on its way and its wait at the target, before an input.
  public var glideMs: Int?
  public init(captureMs: Int? = nil, encodeMs: Int? = nil, imageBytes: Int? = nil, walkMs: Int? = nil, glideMs: Int? = nil, ocrMs: Int? = nil) {
    self.captureMs = captureMs; self.encodeMs = encodeMs; self.imageBytes = imageBytes; self.walkMs = walkMs; self.glideMs = glideMs; self.ocrMs = ocrMs
  }
  /// The name of the header.
  public static let header = "X-ClawdTime-Hands-Cost"
  /// Whole milliseconds of `seconds`, never below zero and never more than a day.
  public static func milliseconds(_ seconds: Double) -> Int {
    guard seconds.isFinite else { return 0 }
    return Int(min(86_400_000, max(0, (seconds * 1000).rounded())))
  }
  /// Adds the parts of another look or glide of the same command.
  public mutating func add(_ other: HandsCost) {
    func bounded(_ value: Int?) -> Int { max(0, min(86_400_000, value ?? 0)) }
    func sum(_ a: Int?, _ b: Int?) -> Int? { a == nil && b == nil ? nil : min(86_400_000, bounded(a) + bounded(b)) }
    captureMs = sum(captureMs, other.captureMs); encodeMs = sum(encodeMs, other.encodeMs)
    imageBytes = sum(imageBytes, other.imageBytes); walkMs = sum(walkMs, other.walkMs)
    ocrMs = sum(ocrMs, other.ocrMs); glideMs = sum(glideMs, other.glideMs)
  }
  /// The value of the header, for example `capture=93;encode=21;bytes=183422;walk=412`. Nil when the
  /// command had none of the parts.
  public var headerValue: String? {
    let parts: [(String, Int?)] = [("capture", captureMs), ("encode", encodeMs), ("bytes", imageBytes), ("walk", walkMs), ("ocr", ocrMs), ("glide", glideMs)]
    let shown = parts.compactMap { name, value in value.map { "\(name)=\(max(0, min(86_400_000, $0)))" } }
    return shown.isEmpty ? nil : shown.joined(separator: ";")
  }
}
