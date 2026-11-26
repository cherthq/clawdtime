import CoreGraphics
import Foundation

/// One requested adjacent desktop, or the inverse of the panel's last verified step.
public enum DesktopDirection: String, Codable, Sendable, CaseIterable {
  case left, right, previous
  public var inverse: DesktopDirection? {
    switch self { case .left: return .right; case .right: return .left; case .previous: return nil }
  }
}

/// Keep only a verified adjacent move. No desktop numbers or private Space IDs.
public struct DesktopSwitchHistory<Surface: Equatable> {
  private var step: (direction: DesktopDirection, from: Surface, to: Surface)?
  public init() {}
  public mutating func invalidate() { step = nil }
  public mutating func verified(_ direction: DesktopDirection, from: Surface, to: Surface) {
    guard direction != .previous, from != to else { step = nil; return }
    step = (direction, from, to)
  }
  public func previous(from current: Surface) -> (direction: DesktopDirection, target: Surface)? {
    guard let step, step.to == current, let inverse = step.direction.inverse else { return nil }
    return (inverse, step.from)
  }
}

/// Full-screen acceptance requires affirmative AX evidence and a window that
/// spans the sole display, allowing only the system menu/notch inset at its top.
/// A half-screen Split View window or an inferred full-screen frame is insufficient.
public enum DesktopSurfaceScope {
  public static func fullScreenGeometry(window: CGRect, display: CGRect) -> Bool {
    display.contains(window) && abs(window.minX - display.minX) <= 1 && abs(window.maxX - display.maxX) <= 1 &&
      abs(window.maxY - display.maxY) <= 1 && window.minY - display.minY <= 80 && window.height >= display.height * 0.85
  }
  public static func permits(window: CGRect, display: CGRect, ordinary: Bool, fullScreen: Bool,
                             activeDisplays: Int, transition: Bool, fullScreenConfirmed: Bool = false) -> Bool {
    guard !window.isNull, !window.isEmpty, !window.intersection(display).isEmpty else { return false }
    guard transition else { return true }
    guard activeDisplays == 1, ordinary, display.contains(window) else { return false }
    return !fullScreen || (fullScreenConfirmed && fullScreenGeometry(window: window, display: display))
  }
}

/// Metadata only: a Quartz row has no screen pixels or window contents.
public struct DesktopWindowEvidence {
  public let id: Int, pid: Int
  public let title: String?
  public let frame: CGRect
  /// How solid the window server draws the window, 0 to 1. Unknown counts as solid.
  public let alpha: Double?
  public init(id: Int, pid: Int, title: String?, frame: CGRect, alpha: Double? = nil) {
    self.id = id; self.pid = pid; self.title = title; self.frame = frame; self.alpha = alpha
  }
}
public enum DesktopWindowVisibility {
  private static func sameFrame(_ a: CGRect, _ b: CGRect) -> Bool {
    abs(a.minX - b.minX) <= 1 && abs(a.minY - b.minY) <= 1 && abs(a.width - b.width) <= 1 && abs(a.height - b.height) <= 1
  }
  /// One window can have two names. The window list of some apps gives the title of the page or the document
  /// alone, and Accessibility gives that title with the app's own words after a dash: a browser adds its name
  /// and the profile ("Inbox" and "Inbox - Browser \u{2013} Work"). Both name the same window. Without this
  /// no transition could start from a browser window. A list name that is missing or empty names no window.
  static func sameTitle(listed: String?, accessible: String) -> Bool {
    guard let listed else { return false }
    if listed == accessible { return true }
    guard !listed.isEmpty else { return false }
    return [" - ", " \u{2013} ", " \u{2014} "].contains { accessible.hasPrefix(listed + $0) }
  }
  /// The strip that a full-screen app of the same pid keeps over the top of its window: full width, at most 80
  /// points and 12 percent high, and not a window or a dialog in Accessibility. Its controls are parts of the
  /// focused window.
  private static func isStrip(_ strip: DesktopWindowEvidence, pid: Int, window: DesktopWindowEvidence, frame: CGRect,
                              fullScreenConfirmed: Bool, display: CGRect, accessibleFrames: [CGRect]?) -> Bool {
    guard fullScreenConfirmed, DesktopSurfaceScope.fullScreenGeometry(window: frame, display: display), let accessibleFrames else { return false }
    return strip.pid == pid && strip.id != window.id &&
      abs(strip.frame.minX - frame.minX) <= 1 && abs(strip.frame.width - frame.width) <= 1 &&
      abs(strip.frame.minY - frame.minY) <= 1 && strip.frame.height > 0 && strip.frame.height <= 80 &&
      strip.frame.height <= frame.height * 0.12 && frame.contains(strip.frame) &&
      !accessibleFrames.contains(where: { sameFrame($0, strip.frame) })
  }

  /// Match exactly one focused AX window to visible Quartz metadata. At most one
  /// same-app full-width auxiliary top strip may precede it, and only when AX
  /// confirms full screen and does not expose the strip as a real window/dialog.
  ///
  /// A sheet (the dialog that hangs from a window: "Do you want to save?") has no Accessibility title, and the
  /// window server lists it under a name of the app's own ("Save"). It is matched by the app and the frame
  /// alone, and only as the top ordinary window: a sheet is always in front of the window that it hangs from.
  ///
  /// This is the whole rule for a move to another app or desktop. The hands' input uses `focusedWindow`.
  public static func focusedWindowID(pid: Int, title: String, frame: CGRect, fullScreenConfirmed: Bool,
                                     display: CGRect, visible: [DesktopWindowEvidence], accessibleFrames: [CGRect]?,
                                     sheet: Bool = false) -> Int? {
    let matches = visible.indices.filter {
      visible[$0].pid == pid && (sheet || sameTitle(listed: visible[$0].title, accessible: title)) && sameFrame(visible[$0].frame, frame)
    }
    guard matches.count == 1, let index = matches.first else { return nil }
    if index == 0 { return visible[index].id }
    guard !sheet, index == 1, isStrip(visible[0], pid: pid, window: visible[index], frame: frame,
      fullScreenConfirmed: fullScreenConfirmed, display: display, accessibleFrames: accessibleFrames) else { return nil }
    return visible[index].id
  }

  /// The most windows of the app's own that a person can see in front of the focused window, and how much of the
  /// focused window they may hide together. Under `unseenAlpha` a window shows nothing. At most `frontLimit`
  /// windows of the app, seen or not, may lie in front.
  public static let coverLimit = 4, coverShare = 0.9, unseenAlpha = 0.05, frontLimit = 8

  /// A window in its own right, as Accessibility names it. Three kinds are parts of another window: a window
  /// of the kind "unknown", which is how an app lists the suggestions of an address bar or a small card, a
  /// help tag, and a text field or text area that the app lists among its windows: the field in which Finder edits the
  /// name of a file lies in a small window of its own over the window of the folder (`inlineField`). Every other kind,
  /// and a window with no kind, stands alone. So does a sheet, whatever its kind.
  public static func standsAlone(role: String?, subrole: String?) -> Bool {
    if role == "AXSheet" { return true }
    return !(role == "AXHelpTag" || role == "AXTextField" || role == "AXTextArea" || subrole == "AXUnknown")
  }

  /// Which window of the app is the surface of the hands' input: the focused window, the main window under an open
  /// menu (`main`), the main window under an inline field that has the keyboard (`field`), or none.
  public enum InputWindow: Equatable, Sendable { case focused, main, field, none }
  /// While a menu of the app is open (a context menu, a menu of the menu bar, the menu of a pop-up button),
  /// Accessibility names that menu as the app's focused window. A menu is no window: it has no title, no minimized
  /// state and no row among the ordinary windows, so it is never a surface, and a look with no surface gives no input
  /// at all. The menu is part of the window that it opened over, the app's main window. For the hands' input that
  /// window is the surface, with every check of a focused window: its title, its place and its row in the window list.
  /// A move to another app or desktop never starts while a menu is open. Every other focused window stays the surface.
  public static func inputWindow(focusedRole: String?, mainRole: String?, input: Bool) -> InputWindow {
    guard focusedRole == "AXMenu" else { return .focused }
    return input && mainRole == "AXWindow" ? .main : .none
  }
  /// The same rule when the app may name no focused window at all. While a context menu or a menu of the menu bar is
  /// open, Finder on macOS 26 answers that it has no focused window, and no menu either. The window list shows the menu
  /// as a window of the app at the level of menus (`menuShown`). With that menu on the screen, the app's main window is
  /// the surface of the hands' input, as under a menu that Accessibility names. With no menu shown, an app with no
  /// focused window gives no surface, as before. A move to another app or desktop never starts while a menu is open.
  ///
  /// Finder also names no focused window while the name of a file or a new folder is open for editing (Return on a
  /// file, or a new folder). The field that has the keyboard is then a text field of the app with no window of its
  /// own: Accessibility gives the app as its parent (`inlineField`). It lies over the window of the folder, the main
  /// window, which is the surface of the hands' input (`field`). The window list shows the field as a small window of
  /// the app in front of that window: a cover, as a list of suggestions is (`focusedWindow`). An open menu wins.
  public static func inputWindow(focused: Bool, focusedRole: String?, mainRole: String?, input: Bool, menuShown: Bool,
                                 inlineField: Bool = false) -> InputWindow {
    guard focused else {
      guard input, mainRole == "AXWindow" else { return .none }
      return menuShown ? .main : inlineField ? .field : .none
    }
    return inputWindow(focusedRole: focusedRole, mainRole: mainRole, input: input)
  }
  /// The element of the app that has the keyboard is an inline field: a text field or a text area whose parent is the
  /// app itself, not a window, lying inside the app's main window. A field inside a window has that window as its
  /// parent chain and is never one; a field with no place, or one outside the main window, is not one either.
  public static func inlineField(role: String?, parentRole: String?, frame: CGRect?, main: CGRect?) -> Bool {
    guard role == "AXTextField" || role == "AXTextArea", parentRole == "AXApplication", let frame, let main,
      frame.width > 0, frame.height > 0, frame.width.isFinite, frame.height.isFinite else { return false }
    return main.insetBy(dx: -1, dy: -1).contains(frame)
  }
  /// An inline field has the keyboard: letters go into the name and Return gives the file that name. An input rests
  /// on a look with the field open or with none, and goes on only while that holds. A field that closed since sends
  /// the next letters to the folder, where they pick a file, and Return to the file that is selected.
  public static func sameField(looked: Bool, now: Bool) -> Bool { looked == now }
  /// The level of the window server at which macOS shows an open menu: a context menu, a menu of the menu bar, the
  /// menu of a pop-up button (`kCGPopUpMenuWindowLevel`).
  public static let menuLevel = 101
  /// A menu of the app `pid` is open on `display`: the window list has a window of that app at the level of menus. A
  /// menu of another process, such as the menu of an icon in the menu bar, is no menu of the app.
  public static func menuShown(_ rows: [ListedWindow], pid: Int, display: CGRect) -> Bool {
    rows.contains { row in
      guard row.owner == pid, row.layer == menuLevel, let frame = row.frame else { return false }
      return !display.intersection(frame).isEmpty
    }
  }
  /// An open menu has the keyboard: letters pick its items and Return chooses one. An input rests on a look with a
  /// menu of the app open or with none, and goes on only while that holds. A menu that opened since, for example after
  /// a Tab or a Space in typed text, or one that closed, sends the next key or click elsewhere than the look said.
  public static func sameMenu(looked: Bool, now: Bool) -> Bool { looked == now }

  /// The focused window of the app can be a panel of its own above the ordinary windows: the Quick Look of a file,
  /// which Finder shows at the level of floating windows, or an inspector. Accessibility names it as the focused window,
  /// and it has the keyboard, so Escape, Space and its close button act on it. The ordinary windows of the list have no
  /// row for it, so it matched no window, and no key or click could go to it. For the hands' input it is the surface
  /// when the window list has exactly one window of the app, above the ordinary level and below the level of menus, at
  /// its place. The list gives such a panel no name or a name of its own (Quick Look has none), so the app and the place
  /// match it, as for a sheet. A panel of another process is never the surface: it stays a window above the ordinary
  /// ones, which takes no click if it came up after the look (`OwnWindows.floatingCover`). ClawdTime's own windows are
  /// never a surface. Windows above the panel are judged by the same rule as windows above any surface.
  public static func panelWindow(pid: Int, frame: CGRect, rows: [ListedWindow], display: CGRect, own: Int) -> DesktopFocusedWindow? {
    guard pid != own else { return nil }
    let matches = rows.filter { row in
      guard row.owner == pid, let layer = row.layer, layer > 0, layer < menuLevel, let listed = row.frame else { return false }
      return sameFrame(listed, frame) && !display.intersection(listed).isEmpty
    }
    guard matches.count == 1, let id = matches[0].id, id > 0 else { return nil }
    return .init(id: id, covers: [], front: 0)
  }

  /// The focused window as the hands' input may use it. It is the match of `focusedWindowID`, and one case more:
  /// small windows of the same app lie in front of the focused window. A browser shows the suggestions of its
  /// address bar in such a window, and a card or a status line is one too. The focused window is still the
  /// surface, and the windows in front come back as `covers`: the hands send no click to a place under one,
  /// because the look does not say what is there.
  ///
  /// Each window in front must be of the same app and not a window in its own right. `standaloneFrames` are the
  /// frames of the app's windows for which `standsAlone` holds: a second document or a dialog in front is another
  /// surface, never a cover. With that list unknown there is no match. A cover must touch the focused window,
  /// and all covers together may hide at most `coverShare` of it. A sheet stays the top window.
  ///
  /// Some apps keep a window in front that shows nothing: a status line that is empty now, a layer for a part
  /// that comes later. It hides nothing from a person, who works through it, so it is no cover and its size
  /// does not count. The strip of a full-screen app is no cover either.
  public static func focusedWindow(pid: Int, title: String, frame: CGRect, fullScreenConfirmed: Bool, display: CGRect,
                                   visible: [DesktopWindowEvidence], accessibleFrames: [CGRect]?, standaloneFrames: [CGRect]?,
                                   sheet: Bool = false) -> DesktopFocusedWindow? {
    if let id = focusedWindowID(pid: pid, title: title, frame: frame, fullScreenConfirmed: fullScreenConfirmed, display: display,
      visible: visible, accessibleFrames: accessibleFrames, sheet: sheet) {
      return .init(id: id, covers: [], front: visible.firstIndex(where: { $0.id == id }) ?? 0)
    }
    guard !sheet, let standaloneFrames else { return nil }
    let matches = visible.indices.filter {
      visible[$0].pid == pid && sameTitle(listed: visible[$0].title, accessible: title) && sameFrame(visible[$0].frame, frame)
    }
    guard matches.count == 1, let index = matches.first, index >= 1, index <= frontLimit else { return nil }
    let area = frame.width * frame.height
    guard area.isFinite, area > 0 else { return nil }
    var covers: [DesktopCover] = [], unseen: [DesktopUnseen] = [], hidden: CGFloat = 0, strips = 0
    for row in visible[..<index] {
      guard row.pid == pid, row.id != visible[index].id,
        !standaloneFrames.contains(where: { sameFrame($0, row.frame) }) else { return nil }
      if isStrip(row, pid: pid, window: visible[index], frame: frame, fullScreenConfirmed: fullScreenConfirmed, display: display,
        accessibleFrames: accessibleFrames) {
        strips += 1
        continue
      }
      if let alpha = row.alpha, alpha.isFinite, alpha >= 0, alpha < unseenAlpha {
        unseen.append(.init(id: row.id, frame: row.frame, alpha: alpha))
        continue
      }
      let part = row.frame.intersection(frame)
      guard row.frame.width >= 1, row.frame.height >= 1, row.frame.width.isFinite, row.frame.height.isFinite,
        row.frame.insetBy(dx: -1, dy: -1).intersects(frame) else { return nil }
      if !part.isNull { hidden += part.width * part.height }
      covers.append(.init(id: row.id, frame: row.frame))
    }
    guard strips <= 1, covers.count <= coverLimit, hidden <= area * coverShare else { return nil }
    return .init(id: visible[index].id, covers: covers, front: index, unseen: unseen)
  }
}

/// A window of the same app in front of the focused window that shows nothing now: its number, its place and
/// how solid it is. It hides nothing, but one that starts to show between the look and a click could take it.
public struct DesktopUnseen: Equatable, Sendable {
  public let id: Int
  public let frame: CGRect
  public let alpha: Double
  public init(id: Int, frame: CGRect, alpha: Double) { self.id = id; self.frame = frame; self.alpha = alpha }
}

/// A window of the same app that a person can see in front of the focused window: its number in the window
/// server's list and its place. Another window at the same place is another cover.
public struct DesktopCover: Equatable, Sendable {
  public let id: Int
  public let frame: CGRect
  public init(id: Int, frame: CGRect) { self.id = id; self.frame = frame }
}

/// The focused window that the hands act on: its number in the window server's list, the windows of the same
/// app that a person can see in front of it, top first, how many windows of the app lie in front at all, and
/// the ones among them that show nothing.
public struct DesktopFocusedWindow: Equatable, Sendable {
  public let id: Int
  public let covers: [DesktopCover]
  public let front: Int
  public let unseen: [DesktopUnseen]
  public init(id: Int, covers: [DesktopCover], front: Int, unseen: [DesktopUnseen] = []) {
    self.id = id; self.covers = covers; self.front = front; self.unseen = unseen
  }
  /// The place is under a window in front: a click there would not go to the focused window.
  public func hides(_ point: CGPoint) -> Bool { Self.hides(covers, point) }
  /// The same rule for covers that the panel holds.
  public static func hides(_ covers: [DesktopCover], _ point: CGPoint) -> Bool { covers.contains { $0.frame.contains(point) } }
  /// True when `point` lies inside the exact same topmost same-app cover (same window ID and frame)
  /// that was already present when the screen was observed. Any new, moved, resized, replaced,
  /// vanished or higher cover at `point` returns false.
  public static func permitsObservedCover(_ point: CGPoint, observed: [DesktopCover], current: [DesktopCover]) -> Bool {
    guard let seen = observed.first(where: { $0.frame.contains(point) }),
          let now = current.first(where: { $0.frame.contains(point) }) else { return false }
    return seen == now
  }
}

/// App switching can stay within a Space or enter another. A changed PID and
/// stable independently observed window are required; desktop history is separate.
public struct AppSwitchSettlement<Surface: Equatable> {
  private let originPID: Int
  private var settlement: DesktopSettlement<Surface>
  private var lastEpoch: Int?
  public init(originPID: Int, at: TimeInterval) { self.originPID = originPID; settlement = .init(at: at) }
  public mutating func sample(_ surface: Surface?, pid: Int?, epoch: Int, at: TimeInterval) -> DesktopSettlement<Surface>.Decision {
    if lastEpoch != epoch { _ = settlement.sample(nil, at: at); lastEpoch = epoch }
    return settlement.sample(pid != nil && pid != originPID ? surface : nil, at: at)
  }
}

public struct DesktopResolvedShortcut: Equatable, Sendable {
  public let code: UInt16
  public let flags: UInt64
  public init(code: UInt16, flags: UInt64) { self.code = code; self.flags = flags }
}
public struct DesktopShortcutPair: Equatable, Sendable {
  public let left: DesktopResolvedShortcut, right: DesktopResolvedShortcut
  public func shortcut(for direction: DesktopDirection) -> DesktopResolvedShortcut? {
    switch direction { case .left: return left; case .right: return right; case .previous: return nil }
  }
}

/// Environment values attest the settings' meaning; public Carbon inventory can
/// independently verify only that those distinct combinations are enabled.
public enum DesktopShortcutConfiguration {
  private static let standardFlags = KeyCombo.command | KeyCombo.shift | KeyCombo.option | KeyCombo.control
  // Carbon kEventKeyModifierFnMask. CopySymbolicHotKeys can include this
  // inherent arrow-key bit even when Settings displays only Control + Arrow.
  private static let carbonFunction: UInt64 = 131072
  private static func adjacentArrow(_ code: UInt16) -> Bool { code == 123 || code == 124 }

  private static func resolved(_ key: DesktopHotKey) -> DesktopResolvedShortcut? {
    let carbonMask: UInt64 = 256 | 512 | 2048 | 4096 | (adjacentArrow(key.code) ? carbonFunction : 0)
    guard key.carbonModifiers & ~carbonMask == 0 else { return nil }
    var flags: UInt64 = 0
    if key.carbonModifiers & 256 != 0 { flags |= KeyCombo.command }
    if key.carbonModifiers & 512 != 0 { flags |= KeyCombo.shift }
    if key.carbonModifiers & 2048 != 0 { flags |= KeyCombo.option }
    if key.carbonModifiers & 4096 != 0 { flags |= KeyCombo.control }
    if key.carbonModifiers & carbonFunction != 0 { flags |= KeyCombo.function }
    return .init(code: key.code, flags: flags)
  }

  private static func resolve(_ combo: KeyCombo, code: UInt16, enabled: [DesktopHotKey]) -> DesktopResolvedShortcut? {
    // Explicit Fn combinations remain unsupported. Only the public inventory
    // may supply the inherent Fn bit, and only for named left/right arrows.
    guard combo.flags & ~standardFlags == 0 else { return nil }
    let exact = DesktopResolvedShortcut(code: code, flags: combo.flags)
    let candidates = enabled.compactMap(resolved)
    if candidates.contains(exact) { return exact }
    guard !combo.printing, combo.keyCode == code, adjacentArrow(code) else { return nil }
    let inherentFunction = DesktopResolvedShortcut(code: code, flags: combo.flags | KeyCombo.function)
    return candidates.contains(inherentFunction) ? inherentFunction : nil
  }

  public static func validate(left: KeyCombo?, right: KeyCombo?, leftCode: UInt16?, rightCode: UInt16?,
                              enabled: [DesktopHotKey]?) -> DesktopShortcutPair? {
    guard let left, let right, let leftCode, let rightCode, let enabled,
      let resolvedLeft = resolve(left, code: leftCode, enabled: enabled),
      let resolvedRight = resolve(right, code: rightCode, enabled: enabled) else { return nil }
    let pair = DesktopShortcutPair(left: resolvedLeft, right: resolvedRight)
    guard pair.left != pair.right else { return nil }
    return pair
  }
  public static func isEnabled(_ shortcut: DesktopResolvedShortcut, in enabled: [DesktopHotKey]?) -> Bool {
    let mask = standardFlags | (adjacentArrow(shortcut.code) ? KeyCombo.function : 0)
    guard shortcut.flags & ~mask == 0, let enabled else { return false }
    // Final dispatch verification is exact, including the resolved Fn bit:
    // removing/changing an inventory entry must not silently retarget input.
    return enabled.contains { resolved($0) == shortcut }
  }
}

/// A notification alone, a changed window alone, and an unchanged pinned window
/// are insufficient. Repeated evidence must follow exactly one Space change.
///
/// The same looks also say when nothing moved: no Space change was reported and
/// every look, from the first to the one that ends the wait, showed the surface of
/// before. That is the last desktop on that side, or a shortcut that did nothing.
/// It is known, so it is not an unknown result. One look that shows nothing or
/// another surface, or one Space change, and the result stays unknown.
/// How long a desktop with no window must show before it counts as the arrival of a switch.
public enum DesktopEmptyArrival {
  public static let looks = 4
  public static let seconds = 1.0
  /// The same rule for a caller that keeps its own count: the desktop of arrival, or the one that is left.
  public static func settled(looks: Int, since: TimeInterval?, at: TimeInterval) -> Bool {
    guard let since, at.isFinite, since.isFinite else { return false }
    return looks >= Self.looks && at - since >= seconds
  }
}

public struct DesktopSwitchSettlement<Surface: Equatable> {
  private let origin: Surface
  private let expected: Surface?
  private var settlement: DesktopSettlement<Surface>
  private var lastEpoch: Int?
  private var looks = 0
  private var stayed = true
  private var emptyLooks = 0
  private var emptySince: TimeInterval?
  private var emptyUntil: TimeInterval = 0
  public init(origin: Surface, expected: Surface? = nil, at: TimeInterval) {
    self.origin = origin; self.expected = expected; settlement = .init(at: at)
  }
  /// Ask this only when the wait is over. Three looks at least, as an arrival needs.
  public var notMoved: Bool { stayed && looks >= 3 }
  /// The arrival is a desktop with no window. "No window was read" is not enough for that: the caller says
  /// `empty` only when the window server itself lists no ordinary window on the display. It counts after
  /// exactly one Space change, when four looks in a row, over one second, all showed it. A window, a look
  /// that was not empty, another Space change or a new epoch starts the count again. A move back to a named
  /// desktop (`expected`) never arrives this way: it names a window.
  public var arrivedEmpty: Bool {
    guard expected == nil, emptyLooks >= DesktopEmptyArrival.looks, let emptySince else { return false }
    return emptyUntil - emptySince >= DesktopEmptyArrival.seconds
  }
  public mutating func sample(_ surface: Surface?, empty: Bool = false, spaceChanges: Int, epoch: Int, at: TimeInterval) -> DesktopSettlement<Surface>.Decision {
    looks += 1
    if spaceChanges != 0 || surface != origin { stayed = false }
    if lastEpoch != epoch { emptyLooks = 0; emptySince = nil }
    if spaceChanges == 1, surface == nil, empty, at.isFinite {
      emptyLooks += 1
      if emptySince == nil { emptySince = at }
      emptyUntil = at
    } else { emptyLooks = 0; emptySince = nil }
    if lastEpoch != epoch { _ = settlement.sample(nil, at: at); lastEpoch = epoch }
    guard spaceChanges == 1, let surface, surface != origin, expected.map({ $0 == surface }) ?? true else {
      return settlement.sample(nil, at: at)
    }
    return settlement.sample(surface, at: at)
  }
}
