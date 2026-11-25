import Foundation

/// A transition can settle only from repeated independent observations. Input
/// submission and a Space-change notification are never evidence of success.
public struct DesktopSettlement<Surface: Equatable> {
  public enum Decision: Equatable { case waiting, ready, expired }
  private let began: TimeInterval
  private var stableSince: TimeInterval?
  private var previous: Surface?
  private var samples = 0
  public init(at: TimeInterval) { began = at }
  public mutating func sample(_ surface: Surface?, at: TimeInterval) -> Decision {
    guard at.isFinite, at >= began, at - began < 5 else { return .expired }
    guard let surface else { previous = nil; stableSince = nil; samples = 0; return .waiting }
    if previous != surface { previous = surface; stableSince = at; samples = 1 }
    else { samples += 1 }
    guard let stableSince, samples >= 3, at - stableSince >= 0.6 else { return .waiting }
    return .ready
  }
}

/// The one observation the serialized native hands may act on. Notifications,
/// app/window/geometry changes and transition starts all retire it (`epoch`).
/// The worker gets `surfaceEpoch`, which prevents retargeting an old plan onto
/// a new Space: only `retire` moves it.
public struct DesktopObservationLease<Surface: Equatable> {
  /// The input generation of the panel: anything that changed under a look retires it.
  public private(set) var epoch = 0
  /// The epoch that an observation carries to the worker. It grows only with `retire`: a change of the desktop
  /// or of the display, the session going away, and a move of the hands to another app or desktop. A new window
  /// of the app in front, the first window of an app, a list in front of it, a look with no window and an app
  /// that came forward by itself retire only the input (`epoch`). The worker then finds its target again in the
  /// newer look by its app, window, role, name and place, and never counts such a change as one of the desktop.
  public private(set) var surfaceEpoch = 0
  private var surface: Surface?
  private var observedAt: TimeInterval?
  public init() {}
  /// What the lease holds now, if anything.
  public var held: Surface? { surface }
  public mutating func invalidate() { epoch += 1; surface = nil; observedAt = nil }
  /// The desktop or the display changed, or the hands move to another app or desktop: every old coordinate is retired.
  public mutating func retire() { surfaceEpoch += 1; invalidate() }
  /// A dispatched input consumes freshness, not identity (a focus click can precede typing).
  public mutating func consume() { observedAt = nil }
  public mutating func record(_ value: Surface, at: TimeInterval) {
    if let surface, surface != value { invalidate() }
    surface = value; observedAt = at
  }
  public func permits(_ value: Surface?, at: TimeInterval) -> Bool {
    guard let value, let surface, let observedAt, at.isFinite else { return false }
    return value == surface && at >= observedAt && at - observedAt <= 2
  }
}

/// Narrow native lifecycle hook. Zoom owns the presentation-event contract and
/// may bridge this hook; no image, title, text or presentation coordinates live here.
public enum DesktopTransitionPhase: String, Sendable {
  case switching, waiting, ready, blocked
}

/// Once an external activation/restoration/raise was submitted, an interrupted
/// or unverified result is unknown. Stop never relabels an uncertain effect as
/// a harmless pre-dispatch refusal.
public enum DesktopEffectOutcome {
  public static func failure(_ error: HandError, dispatched: Bool) -> HandError {
    dispatched ? .transitionUnknown : error
  }
}

/// One definition of "arrived" for a request that names an app, the same as
/// `verifiedActivation` in the worker. The hands find one app for the name and
/// report its bundle identifier; arrived means that this app is in front. A name
/// has four accepted forms (bundle identifier, running name, file name, Finder
/// name), so the name itself is never compared again after it was resolved.
/// A window title is compared as every observation carries it: cleaned.
public enum DesktopArrival {
  /// The bundle identifier as an observation carries it.
  public static func identity(_ bundleID: String) -> String { ElementCleaner.line(bundleID, limit: 200) }
  public static func sameApp(resolved: String, front: String?) -> Bool {
    guard let front else { return false }
    let wanted = identity(resolved)
    return !wanted.isEmpty && wanted.caseInsensitiveCompare(identity(front)) == .orderedSame
  }
  /// The same title after the observation's cleaning: a no-break space, a format
  /// character or a cut at the length limit does not make another window of it.
  /// A title that cleans to nothing names no window, so it never fits an untitled one.
  public static func sameTitle(_ one: String, _ other: String) -> Bool {
    let title = ElementCleaner.line(one)
    return !title.isEmpty && title == ElementCleaner.line(other)
  }

  private static let dynamicPatterns: [(regex: NSRegularExpression, replacement: String)] = [
    // Unread counts in brackets/parens bounded by whitespace, separators or string edges (never `.ext`).
    (try! NSRegularExpression(pattern: #"(?:^|(?<=[\s\-–—|]))(?:\(\s*(?:\d{1,3}|\d+\+)\s*\)|\[\s*(?:\d{1,3}|\d+\+)\s*\])(?=$|[\s\-–—|])"#), " "),
    // Elapsed timers in brackets/parens, or bare at the start/end edges of the title.
    (try! NSRegularExpression(pattern: #"(?:^|(?<=[\s\-–—|]))(?:\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)|\[\s*\d{1,2}:\d{2}(?::\d{2})?\s*\])(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"^\d{1,2}:\d{2}(?::\d{2})?(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"(?:^|(?<=[\s\-–—|]))\d{1,2}:\d{2}(?::\d{2})?$"#), " "),
    // Progress percentages in brackets/parens, at title edges, or at the end of a title segment before a separator.
    (try! NSRegularExpression(pattern: #"(?:^|(?<=[\s\-–—|]))(?:\(\s*\d{1,3}(?:\.\d+)?%\s*\)|\[\s*\d{1,3}(?:\.\d+)?%\s*\])(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"^\d{1,3}(?:\.\d+)?%(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"(?:^|(?<=[\s\-–—|]))\d{1,3}(?:\.\d+)?%(?=$|\s+[-–—|](?:\s|$))"#), " "),
    // Tab counts in brackets/parens or at the start/end edges of the title.
    (try! NSRegularExpression(pattern: #"(?i)(?:^|(?<=[\s\-–—|]))(?:\(\s*\d+\s+tabs?\s*\)|\[\s*\d+\s+tabs?\s*\])(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"(?i)^\d+\s+tabs?(?=$|[\s\-–—|])"#), " "),
    (try! NSRegularExpression(pattern: #"(?i)(?:(?:^|\s+)[-–—|]\s*|(?:^|(?<=\s)))\d+\s+tabs?$"#), " "),
  ]
  private static let dirtyDotPatterns: [(regex: NSRegularExpression, replacement: String)] = [
    (try! NSRegularExpression(pattern: #"^(?:[•●◦]\s+)+"#), ""),
    (try! NSRegularExpression(pattern: #"(\s[-–—|]\s+)[•●◦]\s+"#), "$1"),
    (try! NSRegularExpression(pattern: #"(?:\s+[•●◦])+$"#), ""),
  ]
  private static let danglingSeparators: [(regex: NSRegularExpression, replacement: String)] = [
    (try! NSRegularExpression(pattern: #"^[-–—|]+(?:\s+|$)"#), ""),
    (try! NSRegularExpression(pattern: #"(?:^|\s+)[-–—|]+$"#), ""),
    (try! NSRegularExpression(pattern: #"\s+([-–—|])(?:\s+[-–—|])+\s+"#), " $1 "),
  ]

  /// Strips volatile live-window decorations (unread counts like `(3)` or `[12+]`, dirty dots `• `,
  /// edge/bracketed elapsed timers like `04:12`, percentages like `45%`, and tab counts like `- 4 tabs`)
  /// while preserving mid-title timestamps and numbered filenames (e.g. `Report (1).pdf`) and refusing
  /// empty collapse: if stripping would leave nothing, the cleaned title is returned intact.
  public static func normalizeDynamicTitle(_ title: String) -> String {
    let cleaned = ElementCleaner.line(title)
    guard !cleaned.isEmpty else { return "" }
    var working = cleaned
    for _ in 0..<4 {
      let before = working
      for entry in dirtyDotPatterns {
        let range = NSRange(working.startIndex..., in: working)
        working = entry.regex.stringByReplacingMatches(in: working, range: range, withTemplate: entry.replacement)
      }
      working = ElementCleaner.line(working)
      for entry in dynamicPatterns {
        let range = NSRange(working.startIndex..., in: working)
        working = entry.regex.stringByReplacingMatches(in: working, range: range, withTemplate: entry.replacement)
      }
      working = ElementCleaner.line(working)
      if working != cleaned {
        for entry in danglingSeparators {
          let range = NSRange(working.startIndex..., in: working)
          working = entry.regex.stringByReplacingMatches(in: working, range: range, withTemplate: entry.replacement)
        }
        working = ElementCleaner.line(working)
      }
      if working == before || working.isEmpty { break }
    }
    return working.isEmpty ? cleaned : working
  }

  /// True when two titles name the same live window (same `CGWindowID`), tolerating ticking clocks,
  /// unread counters, dirty dots, progress percentages and tab counts. Two distinct titles that collapse
  /// to empty (e.g. `"(3)"` and `"45%"`) never match.
  public static func sameLiveTitle(_ one: String, _ other: String) -> Bool {
    if one == other { return true }
    let a = normalizeDynamicTitle(one), b = normalizeDynamicTitle(other)
    return !a.isEmpty && a == b
  }
}

/// What must hold before the hands try to bring an app forward. A request that
/// names only an app ("open Chrome") is verified by the app in front, so it runs
/// with any number of displays. A request that names a window is verified by that
/// window on the main display, so it needs exactly one display.
public enum DesktopActivationRule {
  public static func refusal(windowNamed: Bool, displays: Int) -> HandError? {
    windowNamed && displays != 1 ? .unsupportedDesktop : nil
  }
}

/// Which standard window of an app a title names. A title is compared as an
/// observation carries it. Two windows with that title are ambiguous: the first
/// is never taken. A request with no title never comes here, because then the
/// app chooses its own window and nothing can be ambiguous.
public enum DesktopWindowChoice {
  public static func index(titled title: String, among titles: [String?]) -> Result<Int, HandError> {
    let matches = titles.indices.filter { index in titles[index].map { DesktopArrival.sameTitle($0, title) } == true }
    guard matches.count <= 1 else { return .failure(.ambiguousTarget) }
    guard let index = matches.first else { return .failure(.targetNotVisible) }
    return .success(index)
  }
}

/// The wait for an app to come to the front after one open request. A cold start
/// takes seconds, so the wait is longer than the settling of a window, and it is
/// read again and again instead of slept through. The app in front counts at any
/// moment of the wait, also at its end. Only an app that is still not in front
/// when the wait is over leaves the result unknown.
public struct DesktopAppWait {
  public enum Decision: Equatable { case waiting, inFront, expired }
  public static let limit: TimeInterval = 6
  private let began: TimeInterval
  public init(at: TimeInterval) { began = at }
  /// The wait is over. An app in front that gave no evidence until now gets no more time.
  public func over(at: TimeInterval) -> Bool { !(at.isFinite && at >= began && at - began < Self.limit) }
  public func sample(inFront: Bool, at: TimeInterval) -> Decision {
    guard at.isFinite, at >= began else { return .expired }
    if inFront { return .inFront }
    return over(at: at) ? .expired : .waiting
  }
}

/// One discovered application; aliases can include its localized and file names.
public struct DesktopAppCandidate: Sendable {
  public let path: String
  public let names: [String]
  public init(path: String, names: [String]) { self.path = path; self.names = names }
}
public enum DesktopAppSelection {
  /// The folders of the apps that a person opens by their names: the apps of the Mac and of its owner, with
  /// their Utilities, and the place of the system browser, where /Applications leads it. A helper of macOS in
  /// CoreServices, an app in a home folder or a copy in another folder comes after them.
  static let appFolders = ["/Applications/", "/System/Applications/",
                           "/System/Volumes/Preboot/Cryptexes/App/System/Applications/", "/System/Cryptexes/App/System/Applications/"]
  /// The one app whose name is the name that was said, in any case. macOS gives some of its helpers the Finder
  /// name of an app: "Tips" and "Contacts" are also helpers in CoreServices. So of several apps with the name,
  /// the one in the app folders wins. Two there, or two outside them and none there, open nothing.
  public static func path(named name: String, candidates: [DesktopAppCandidate]) -> Result<String, HandError> {
    let paths = Set(candidates.filter { $0.names.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }.map(\.path))
    guard let path = paths.first else { return .failure(.notFound) }
    guard paths.count > 1 else { return .success(path) }
    let inFolders = paths.filter { path in appFolders.contains { path.hasPrefix($0) } }
    guard inFolders.count == 1, let chosen = inFolders.first else { return .failure(.ambiguousTarget) }
    return .success(chosen)
  }
  /// The app that a person means by a name, among the apps that open a web address. A person says less than
  /// the full name of a browser. The whole name wins. Else every word that was said is a word of the app's
  /// name, and the name with the fewest words wins. Two such apps open nothing, and so does no such app.
  public static func opener(named name: String, candidates: [DesktopAppCandidate]) -> Result<String, HandError> {
    let whole = path(named: name, candidates: candidates)
    guard case .failure(.notFound) = whole else { return whole }
    func words(_ text: String) -> [String] {
      text.lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
    }
    func choose(_ said: [String]) -> Result<String, HandError> {
      guard !said.isEmpty else { return .failure(.notFound) }
      // For each app, the fewest words of a name of it that holds every word that was said.
      var fewest: [String: Int] = [:]
      for candidate in candidates {
        for alias in candidate.names {
          let has = words(alias)
          if said.allSatisfy(has.contains) { fewest[candidate.path] = min(fewest[candidate.path] ?? .max, has.count) }
        }
      }
      guard let least = fewest.values.min() else { return .failure(.notFound) }
      let best = fewest.filter { $0.value == least }.map(\.key)
      return best.count == 1 ? .success(best[0]) : .failure(.ambiguousTarget)
    }
    // "the Fixture browser", "my Fixture": a word in front that names no app is left out.
    let said = Array(words(name).drop(while: { ["the", "my", "a", "an", "your", "our"].contains($0) }))
    let chosen = choose(said)
    // "the Fixture browser": the word "browser" is in few names, so it may be left out.
    guard case .failure(.notFound) = chosen, said.count > 1, said.last == "browser" else { return chosen }
    return choose(Array(said.dropLast()))
  }
}

/// Successful empty AX inventory is distinct from an unreadable inventory or a
/// nonempty inventory whose windows do not match. Only the first can justify a
/// single app-level reveal for a named-app request without an exact window.
/// The panel does not use this any more: a request that names only an app is
/// now verified by the app in front (`DesktopAppWait`), with no window to reveal.
public enum DesktopAppInventory: Equatable { case empty, nonempty, unavailable }
public struct DesktopAppReveal {
  public private(set) var claimed = false
  public init() {}
  public mutating func claim(running: Bool, exactWindowRequested: Bool, inventory: DesktopAppInventory,
                             refusal: HandError?) -> Result<Void, HandError> {
    if let refusal { return .failure(refusal) }
    guard running, !exactWindowRequested, inventory == .empty, !claimed else { return .failure(.targetNotVisible) }
    claimed = true
    return .success(())
  }
}

public enum DesktopInputOutcome {
  public static func invalidResult(command: HandCommand, submitted: Bool) -> HandError {
    switch command {
    case .openApp, .switchDesktop, .switchPreviousApp: return .transitionUnknown
    default: return submitted ? .inputUnknown : .failed
    }
  }
  public static func failure(_ error: HandError, submitted: Bool, interrupted: Bool) -> HandError {
    // A desktop switch gives its own verdict after its key went out: unknown, or known
    // not to have moved. Every other failure after input began may have typed or
    // clicked something, so it stays unknown and is never sent again.
    if submitted && error != .transitionUnknown && error != .desktopUnchanged { return .inputUnknown }
    return error
  }
}

/// Command+Tab goes to another app of the app switcher, which shows regular apps
/// only. With no regular app besides the one in front, the keys change nothing and
/// the wait for another app could only end as unknown. So the hands refuse before
/// anything is sent. ClawdTime itself is never a place to go back to.
public enum DesktopAppSwitch {
  public static func hasPrevious(regular: [Int], front: Int?, own: Int) -> Bool {
    regular.contains { $0 != front && $0 != own }
  }
}
