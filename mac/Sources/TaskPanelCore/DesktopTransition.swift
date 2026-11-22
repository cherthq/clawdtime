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
/// app/window/geometry changes and transition starts all retire it. Epochs are
/// also sent to the worker to prevent retargeting an old plan onto a new Space.
public struct DesktopObservationLease<Surface: Equatable> {
  public private(set) var epoch = 0
  private var surface: Surface?
  private var observedAt: TimeInterval?
  public init() {}
  public mutating func invalidate() { epoch += 1; surface = nil; observedAt = nil }
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
  public static func sameTitle(_ one: String, _ other: String) -> Bool {
    ElementCleaner.line(one) == ElementCleaner.line(other)
  }
}

/// One discovered application; aliases can include its localized and file names.
public struct DesktopAppCandidate: Sendable {
  public let path: String
  public let names: [String]
  public init(path: String, names: [String]) { self.path = path; self.names = names }
}
public enum DesktopAppSelection {
  public static func path(named name: String, candidates: [DesktopAppCandidate]) -> Result<String, HandError> {
    let paths = Set(candidates.filter { $0.names.contains { $0.caseInsensitiveCompare(name) == .orderedSame } }.map(\.path))
    guard paths.count <= 1 else { return .failure(.ambiguousTarget) }
    guard let path = paths.first else { return .failure(.notFound) }
    return .success(path)
  }
}

/// Successful empty AX inventory is distinct from an unreadable inventory or a
/// nonempty inventory whose windows do not match. Only the first can justify a
/// single app-level reveal for a named-app request without an exact window.
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
    if submitted && error != .transitionUnknown { return .inputUnknown }
    return error
  }
}
