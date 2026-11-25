import CoreGraphics
import Foundation

// Computer use, as the desktop panel takes part in it. A worker in the task
// service decides one action at a time. The panel is the hands: it sees the
// screen and sends input, because macOS gives those two rights to one app that
// the person can see and stop. These types mirror `connectors/computer/ports.ts`.
//
// All coordinates are screen points of the main display, with the origin at the
// top left. A text limit counts UTF-16 units, as the service counts them.

/// Any key of a JSON object, to find the ones that the contract does not name.
private struct AnyKey: CodingKey {
  var stringValue: String
  var intValue: Int? { nil }
  init?(stringValue: String) { self.stringValue = stringValue }
  init?(intValue: Int) { return nil }
}
enum HandsShape {
  /// The contract is strict: an object with a key outside it is refused whole.
  static func only(_ allowed: [String], in decoder: Decoder) throws {
    let found = try decoder.container(keyedBy: AnyKey.self).allKeys
    guard found.allSatisfy({ allowed.contains($0.stringValue) }) else { throw PanelFailure.response }
  }
  static func fits(_ text: String, _ limit: Int) -> Bool { text.utf16.count <= limit }
}

/// One thing on the screen that the Accessibility tree names.
public struct ScreenElement: Codable, Equatable, Sendable {
  /// A number that names the element inside one observation only.
  public let id: Int
  /// The Accessibility role, for example AXButton, AXTextField, AXLink.
  public let role: String
  /// Its label, title or description, as one clean line.
  public let title: String
  /// What it holds. Never present for a secure field.
  public let value: String?
  public let x: Double, y: Double, w: Double, h: Double
  public let enabled: Bool
  public let focused: Bool
  /// A password field. The worker never types into it and never reads it.
  public let secure: Bool
  public init(id: Int, role: String, title: String, value: String? = nil, x: Double, y: Double, w: Double, h: Double,
              enabled: Bool, focused: Bool, secure: Bool) {
    self.id = id; self.role = role; self.title = title; self.value = value
    self.x = x; self.y = y; self.w = w; self.h = h
    self.enabled = enabled; self.focused = focused; self.secure = secure
  }
  public func validate() throws {
    guard id >= 0, HandsShape.fits(role, 60), HandsShape.fits(title, 200), value.map({ HandsShape.fits($0, 200) }) ?? true,
      x.isFinite, y.isFinite, w.isFinite, h.isFinite, !(secure && value != nil) else { throw PanelFailure.configuration }
  }
}

/// What the hands saw at one moment.
public struct Observation: Codable, Equatable, Sendable {
  public struct Screen: Codable, Equatable, Sendable {
    public let width: Double, height: Double, scale: Double
    public init(width: Double, height: Double, scale: Double) { self.width = width; self.height = height; self.scale = scale }
  }
  public struct Cursor: Codable, Equatable, Sendable {
    public let x: Double, y: Double
    public init(x: Double, y: Double) { self.x = x; self.y = y }
  }
  /// The app and the window in front.
  public struct App: Codable, Equatable, Sendable {
    public let name: String, bundleId: String, window: String
    public init(name: String, bundleId: String, window: String) { self.name = name; self.bundleId = bundleId; self.window = window }
  }
  /// Milliseconds since 1970.
  public let at: Double
  /// Native desktop generation. A changed epoch retires every old coordinate.
  public let surfaceEpoch: Int?
  public let screen: Screen
  public let cursor: Cursor
  public let app: App
  public let elements: [ScreenElement]
  /// A JPEG as base64, at most 1280 pixels wide. Absent when none was asked for.
  public let image: String?
  public let imageWidth: Int?
  public let imageHeight: Int?
  public init(at: Double, screen: Screen, cursor: Cursor, app: App, elements: [ScreenElement],
              image: String? = nil, imageWidth: Int? = nil, imageHeight: Int? = nil, surfaceEpoch: Int? = nil) {
    self.at = at; self.screen = screen; self.cursor = cursor; self.app = app; self.elements = elements
    self.image = image; self.imageWidth = imageWidth; self.imageHeight = imageHeight; self.surfaceEpoch = surfaceEpoch
  }
  public static let maxElements = 400, maxImageCharacters = 4_000_000
  public func validate() throws {
    guard surfaceEpoch.map({ $0 >= 0 }) ?? true, at.isFinite, screen.width.isFinite, screen.height.isFinite, screen.scale.isFinite, cursor.x.isFinite, cursor.y.isFinite,
      HandsShape.fits(app.name, 120), HandsShape.fits(app.bundleId, 200), HandsShape.fits(app.window, 200),
      elements.count <= Self.maxElements, (image?.utf8.count ?? 0) <= Self.maxImageCharacters,
      imageWidth.map({ $0 > 0 }) ?? true, imageHeight.map({ $0 > 0 }) ?? true else { throw PanelFailure.configuration }
    for element in elements { try element.validate() }
  }
}

/// One command for the hands.
public enum HandCommand: Equatable, Sendable {
  public enum Button: String, Codable, Sendable { case left, right }
  case observe(image: Bool, elements: Bool)
  case move(x: Double, y: Double)
  case click(x: Double, y: Double, button: Button, count: Int, allowCover: Bool? = nil)
  case drag(fromX: Double, fromY: Double, toX: Double, toY: Double)
  /// Lines. Positive dy scrolls the content up, as a wheel turned toward the person.
  case scroll(x: Double, y: Double, dx: Double, dy: Double)
  case type(text: String)
  /// Keys joined by "+", modifiers first: "cmd+s", "cmd+shift+4", "return", "escape", "tab".
  case key(combo: String)
  case openApp(name: String, window: String? = nil)
  case switchDesktop(direction: DesktopDirection)
  case switchPreviousApp
  /// A web address, opened with no pointer and no key. `browser` is the name of the app that opens it, as a
  /// person says it. Without it the usual browser of this Mac opens the address.
  case openURL(url: String, browser: String? = nil)
  /// Quits a running app by its name, the polite way: the app may ask about work that is not saved, and stay.
  case quitApp(name: String)
  case wait(ms: Int)
  /// A picture of one part of the main display, larger than the same part of an observation: a closer look at
  /// small things. The part is in screen points from the top left; `width` and `height` are the pixels of the
  /// picture. Nothing is sent to an app, and no Accessibility tree is read.
  case zoom(x: Double, y: Double, w: Double, h: Double, width: Int, height: Int)

  /// The name of the command in the contract.
  public var kind: String {
    switch self {
    case .observe: return "observe"
    case .move: return "move"
    case .click: return "click"
    case .drag: return "drag"
    case .scroll: return "scroll"
    case .type: return "type"
    case .key: return "key"
    case .openApp: return "open_app"
    case .switchDesktop: return "switch_desktop"
    case .switchPreviousApp: return "switch_previous_app"
    case .openURL: return "open_url"
    case .quitApp: return "quit_app"
    case .wait: return "wait"
    case .zoom: return "zoom"
    }
  }
  /// Where a pointing command starts. The guided cursor travels there before the event.
  public var pointsAt: CGPoint? {
    switch self {
    case .move(let x, let y), .click(let x, let y, _, _, _), .scroll(let x, let y, _, _): return CGPoint(x: x, y: y)
    case .drag(let x, let y, _, _): return CGPoint(x: x, y: y)
    default: return nil
    }
  }
  /// Every place that a pointing command touches.
  public var places: [CGPoint] {
    if case .drag(let fromX, let fromY, let toX, let toY) = self { return [CGPoint(x: fromX, y: fromY), CGPoint(x: toX, y: toY)] }
    return pointsAt.map { [$0] } ?? []
  }
  /// The command goes to the keyboard.
  public var usesKeyboard: Bool {
    switch self {
    case .type, .key: return true
    default: return false
    }
  }
  /// The command sends input or reads the Accessibility tree.
  public var needsAccessibility: Bool {
    switch self {
    case .observe(_, let elements): return elements
    case .move, .click, .drag, .scroll, .type, .key, .openApp, .switchDesktop, .switchPreviousApp: return true
    case .openURL, .quitApp, .wait, .zoom: return false
    }
  }
  /// The command takes a picture of the screen.
  public var needsScreenRecording: Bool {
    if case .observe(let image, _) = self { return image }
    if case .zoom = self { return true }
    if case .openApp = self { return true }
    if case .switchDesktop = self { return true }
    if case .switchPreviousApp = self { return true }
    return false
  }
  /// The right that the command needs and macOS has not given. With one missing, nothing runs.
  public func missingRight(accessibility: Bool, screenRecording: Bool) -> HandError? {
    if needsAccessibility && !accessibility { return .noAccessibility }
    if needsScreenRecording && !screenRecording { return .noScreenRecording }
    return nil
  }
}

extension HandCommand: Codable {
  private enum Key: String, CodingKey {
    case kind, image, elements, x, y, w, h, width, height, button, count, allowCover, fromX, fromY, toX, toY, dx, dy, text, combo, name, window, direction, url, browser, ms
  }
  public init(from decoder: Decoder) throws {
    let box = try decoder.container(keyedBy: Key.self)
    func only(_ keys: Key...) throws { try HandsShape.only(["kind"] + keys.map(\.rawValue), in: decoder) }
    func number(_ key: Key) throws -> Double {
      let value = try box.decode(Double.self, forKey: key)
      guard value.isFinite else { throw PanelFailure.response }
      return value
    }
    func string(_ key: Key, _ limit: Int) throws -> String {
      let value = try box.decode(String.self, forKey: key)
      guard HandsShape.fits(value, limit) else { throw PanelFailure.response }
      return value
    }
    switch try box.decode(String.self, forKey: .kind) {
    case "observe":
      try only(.image, .elements)
      self = .observe(image: try box.decode(Bool.self, forKey: .image), elements: try box.decode(Bool.self, forKey: .elements))
    case "move":
      try only(.x, .y)
      self = .move(x: try number(.x), y: try number(.y))
    case "click":
      try only(.x, .y, .button, .count, .allowCover)
      guard let button = Button(rawValue: try box.decode(String.self, forKey: .button)) else { throw PanelFailure.response }
      let count = try box.decode(Int.self, forKey: .count)
      guard count == 1 || count == 2 else { throw PanelFailure.response }
      let allowCover = try box.decodeIfPresent(Bool.self, forKey: .allowCover)
      self = .click(x: try number(.x), y: try number(.y), button: button, count: count, allowCover: allowCover == true ? true : nil)
    case "drag":
      try only(.fromX, .fromY, .toX, .toY)
      self = .drag(fromX: try number(.fromX), fromY: try number(.fromY), toX: try number(.toX), toY: try number(.toY))
    case "scroll":
      try only(.x, .y, .dx, .dy)
      self = .scroll(x: try number(.x), y: try number(.y), dx: try number(.dx), dy: try number(.dy))
    case "type":
      try only(.text)
      self = .type(text: try string(.text, 4000))
    case "key":
      try only(.combo)
      self = .key(combo: try string(.combo, 40))
    case "open_app":
      try only(.name, .window)
      let window = try box.decodeIfPresent(String.self, forKey: .window)
      guard window.map({ HandsTarget.windowTitle($0) != nil }) ?? true else { throw PanelFailure.response }
      self = .openApp(name: try string(.name, 120), window: window)
    case "switch_previous_app":
      try only()
      self = .switchPreviousApp
    case "switch_desktop":
      try only(.direction)
      self = .switchDesktop(direction: try box.decode(DesktopDirection.self, forKey: .direction))
    case "open_url":
      try only(.url, .browser)
      let browser = try box.decodeIfPresent(String.self, forKey: .browser)
      guard browser.map({ HandsTarget.appName($0) != nil }) ?? true else { throw PanelFailure.response }
      self = .openURL(url: try string(.url, 2000), browser: browser)
    case "quit_app":
      try only(.name)
      self = .quitApp(name: try string(.name, 120))
    case "wait":
      try only(.ms)
      let ms = try box.decode(Int.self, forKey: .ms)
      guard (0...10_000).contains(ms) else { throw PanelFailure.response }
      self = .wait(ms: ms)
    case "zoom":
      try only(.x, .y, .w, .h, .width, .height)
      let width = try box.decode(Int.self, forKey: .width), height = try box.decode(Int.self, forKey: .height)
      let w = try number(.w), h = try number(.h)
      // A part of the screen with a size, and a picture that fits the contract.
      guard w >= 8, h >= 8, (16...HandsZoom.maxSide).contains(width), (16...HandsZoom.maxSide).contains(height)
        else { throw PanelFailure.response }
      self = .zoom(x: try number(.x), y: try number(.y), w: w, h: h, width: width, height: height)
    default:
      // A kind that this panel does not know is never run.
      throw PanelFailure.response
    }
  }
  public func encode(to encoder: Encoder) throws {
    var box = encoder.container(keyedBy: Key.self)
    try box.encode(kind, forKey: .kind)
    switch self {
    case .observe(let image, let elements):
      try box.encode(image, forKey: .image); try box.encode(elements, forKey: .elements)
    case .move(let x, let y):
      try box.encode(x, forKey: .x); try box.encode(y, forKey: .y)
    case .click(let x, let y, let button, let count, let allowCover):
      try box.encode(x, forKey: .x); try box.encode(y, forKey: .y)
      try box.encode(button, forKey: .button); try box.encode(count, forKey: .count)
      if allowCover == true { try box.encode(true, forKey: .allowCover) }
    case .drag(let fromX, let fromY, let toX, let toY):
      try box.encode(fromX, forKey: .fromX); try box.encode(fromY, forKey: .fromY)
      try box.encode(toX, forKey: .toX); try box.encode(toY, forKey: .toY)
    case .scroll(let x, let y, let dx, let dy):
      try box.encode(x, forKey: .x); try box.encode(y, forKey: .y)
      try box.encode(dx, forKey: .dx); try box.encode(dy, forKey: .dy)
    case .type(let text): try box.encode(text, forKey: .text)
    case .key(let combo): try box.encode(combo, forKey: .combo)
    case .openApp(let name, let window):
      try box.encode(name, forKey: .name); try box.encodeIfPresent(window, forKey: .window)
    case .switchDesktop(let direction): try box.encode(direction, forKey: .direction)
    case .switchPreviousApp: break
    case .openURL(let url, let browser):
      try box.encode(url, forKey: .url); try box.encodeIfPresent(browser, forKey: .browser)
    case .quitApp(let name): try box.encode(name, forKey: .name)
    case .wait(let ms): try box.encode(ms, forKey: .ms)
    case .zoom(let x, let y, let w, let h, let width, let height):
      try box.encode(x, forKey: .x); try box.encode(y, forKey: .y); try box.encode(w, forKey: .w); try box.encode(h, forKey: .h)
      try box.encode(width, forKey: .width); try box.encode(height, forKey: .height)
    }
  }
}

/// The limits of a closer look.
public enum HandsZoom {
  /// The longest side of its picture, in pixels.
  public static let maxSide = 1600
  /// The part of the display that the picture shows: the part asked for, cut to the display. Nil when nothing
  /// of it is on the display. Points from the top left.
  public static func region(x: Double, y: Double, w: Double, h: Double, display: CGRect) -> CGRect? {
    let asked = CGRect(x: x, y: y, width: w, height: h)
    guard [x, y, w, h].allSatisfy(\.isFinite) else { return nil }
    let part = asked.intersection(CGRect(origin: .zero, size: display.size))
    return part.isNull || part.width < 1 || part.height < 1 ? nil : part
  }
}

/// What the panel reads from `GET /desktop/hands/next`: the next command, if one
/// waits, and what to show while the worker runs.
/// `GET /desktop/computer`, as far as the panel reads it: `enabled` is true when the worker that
/// commands these hands is the engine of the service, and its switch is on.
public struct ComputerEngine: Decodable, Equatable, Sendable {
  public let enabled: Bool
  public init(enabled: Bool) { self.enabled = enabled }
}

public struct HandsNext: Codable, Equatable, Sendable {
  public struct Pending: Codable, Equatable, Sendable {
    public let seq: Int
    public let command: HandCommand
    /// Why, in a few words, for the bar: "Click Save".
    public let label: String
    public init(seq: Int, command: HandCommand, label: String) { self.seq = seq; self.command = command; self.label = label }
    public init(from decoder: Decoder) throws {
      try HandsShape.only(["seq", "command", "label"], in: decoder)
      let box = try decoder.container(keyedBy: CodingKeys.self)
      seq = try box.decode(Int.self, forKey: .seq)
      command = try box.decode(HandCommand.self, forKey: .command)
      label = try box.decode(String.self, forKey: .label)
    }
  }
  public struct Run: Codable, Equatable, Sendable {
    public let active: Bool
    public let goal: String
    public let step: Int
    /// idle, running, waiting_for_person, stopping.
    public let state: String
    public init(active: Bool, goal: String, step: Int, state: String) { self.active = active; self.goal = goal; self.step = step; self.state = state }
    public init(from decoder: Decoder) throws {
      try HandsShape.only(["active", "goal", "step", "state"], in: decoder)
      let box = try decoder.container(keyedBy: CodingKeys.self)
      active = try box.decode(Bool.self, forKey: .active)
      goal = try box.decode(String.self, forKey: .goal)
      step = try box.decode(Int.self, forKey: .step)
      state = try box.decode(String.self, forKey: .state)
    }
  }
  public let version: Int
  public let command: Pending?
  public let run: Run
  private enum CodingKeys: String, CodingKey { case version, command, run }
  public init(version: Int = 1, command: Pending?, run: Run) { self.version = version; self.command = command; self.run = run }
  public init(from decoder: Decoder) throws {
    try HandsShape.only(["version", "command", "run"], in: decoder)
    let box = try decoder.container(keyedBy: CodingKeys.self)
    version = try box.decode(Int.self, forKey: .version)
    // The key is always there. With no command it holds null.
    guard box.contains(.command) else { throw PanelFailure.response }
    command = try box.decodeIfPresent(Pending.self, forKey: .command)
    run = try box.decode(Run.self, forKey: .run)
  }
  public func encode(to encoder: Encoder) throws {
    var box = encoder.container(keyedBy: CodingKeys.self)
    try box.encode(version, forKey: .version)
    try box.encode(command, forKey: .command)
    try box.encode(run, forKey: .run)
  }
  public func validate() throws {
    guard version == 1, HandsShape.fits(run.goal, 200), run.step >= 0, HandsShape.fits(run.state, 40),
      command.map({ $0.seq > 0 && HandsShape.fits($0.label, 120) }) ?? true else { throw PanelFailure.response }
  }
}

/// Why a command did not run.
public enum HandError: String, Codable, CaseIterable, Error, Sendable {
  case noAccessibility = "no_accessibility"
  case noScreenRecording = "no_screen_recording"
  case stoppedByPerson = "stopped_by_person"
  case notFound = "not_found"
  case refused
  case failed
  case desktopDisabled = "desktop_disabled"
  case desktopShortcutUnavailable = "desktop_shortcut_unavailable"
  case desktopHistoryUnavailable = "desktop_history_unavailable"
  case ambiguousTarget = "ambiguous_target"
  case unsupportedDesktop = "unsupported_desktop"
  case targetNotVisible = "target_not_visible"
  /// The shortcut for a desktop switch went out and the desktop is known not to have moved.
  case desktopUnchanged = "desktop_unchanged"
  case transitionUnknown = "transition_unknown"
  case inputUnknown = "input_unknown"
  case staleObservation = "stale_observation"
}

/// What the panel posts to `POST /desktop/hands/result`.
public struct HandResult: Codable, Equatable, Sendable {
  public let seq: Int
  public let ok: Bool
  public let error: HandError?
  public let observation: Observation?
  /// After open_app: the bundle identifier of the app that the hands found for the name.
  /// The worker compares it with the app in front, so the form of the name does not matter.
  public let resolvedBundleId: String?
  /// The person moved the mouse or pressed a key while the hands acted.
  public let interrupted: Bool?
  public init(seq: Int, ok: Bool, error: HandError? = nil, observation: Observation? = nil, interrupted: Bool? = nil,
              resolvedBundleId: String? = nil) {
    self.seq = seq; self.ok = ok; self.error = error; self.observation = observation; self.interrupted = interrupted
    self.resolvedBundleId = resolvedBundleId
  }
  /// The command ran. Input that was sent is not proof of what the app did with it.
  public static func done(_ seq: Int, observation: Observation? = nil, interrupted: Bool = false,
                          resolvedBundleId: String? = nil) -> HandResult {
    HandResult(seq: seq, ok: true, observation: observation, interrupted: interrupted ? true : nil, resolvedBundleId: resolvedBundleId)
  }
  /// The command did not run, and why.
  public static func failure(_ seq: Int, _ error: HandError, interrupted: Bool = false) -> HandResult {
    HandResult(seq: seq, ok: false, error: error, interrupted: interrupted ? true : nil)
  }
  public func validate() throws {
    guard seq > 0, !ok || error == nil, resolvedBundleId.map({ HandsShape.fits($0, 200) }) ?? true else { throw PanelFailure.configuration }
    try observation?.validate()
  }
}
