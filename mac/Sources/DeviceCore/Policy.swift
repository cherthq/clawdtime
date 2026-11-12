import CryptoKit
import Foundation

public struct HelperError: Error, LocalizedError {
  public let status: Int
  public let message: String
  public init(_ status: Int, _ message: String) {
    self.status = status
    self.message = message
  }
  public var errorDescription: String? { message }
}
public struct DisplayPermission: Codable {
  public var displayId: UInt32
  public var viewers: [String]
  public var controllers: [String]
  public init(displayId: UInt32, viewers: [String], controllers: [String]) {
    self.displayId = displayId
    self.viewers = viewers
    self.controllers = controllers
  }
}
public struct HelperConfig: Codable {
  public var deviceId: String
  public var bind: String
  public var port: UInt16
  public var secret: String
  public var displays: [DisplayPermission]
  public init(
    deviceId: String, bind: String = "127.0.0.1", port: UInt16 = 4213, secret: String,
    displays: [DisplayPermission]
  ) {
    self.deviceId = deviceId
    self.bind = bind
    self.port = port
    self.secret = secret
    self.displays = displays
  }
  public func validate() throws {
    let octets = bind.split(separator: ".").compactMap { UInt8($0) }
    let tailnet =
      octets.count == 4 && octets[0] == 100 && (64...127).contains(octets[1])
      && octets.map(String.init).joined(separator: ".") == bind
    guard bind == "127.0.0.1" || tailnet else {
      throw HelperError(400, "Bind only to loopback or an explicit Tailscale IPv4 address.")
    }
    guard validID(deviceId), secret.utf8.count >= 32, port > 0,
      Set(displays.map(\.displayId)).count == displays.count,
      displays.allSatisfy({
        $0.displayId > 0 && $0.viewers.allSatisfy(validID) && $0.controllers.allSatisfy(validID)
      })
    else {
      throw HelperError(400, "Invalid device configuration.")
    }
  }
}
public func validID(_ value: String) -> Bool {
  !value.isEmpty && value.utf8.count <= 160
    && value.unicodeScalars.allSatisfy {
      CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        .contains($0)
    }
}
public func fingerprint<T: Encodable>(_ value: T) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
}
public func authenticated(_ candidate: String, secret: String) -> Bool {
  let a = Array(candidate.utf8)
  let b = Array(("Bearer " + secret).utf8)
  guard a.count == b.count else { return false }
  return zip(a, b).reduce(UInt8(0)) { $0 | ($1.0 ^ $1.1) } == 0
}
public struct Lease: Codable, Equatable {
  public var id: String
  public var deviceId: String
  public var memberId: String
  public var callId: String
  public var displayId: UInt32
  public var mode: String
  public var expiresAt: Date
  public var protocolVersion: Int?
  public var sessionId: String?
  public var executorEpoch: Int?
  public var policyRevision: Int?
  public var executor: String?
  public init(
    id: String, deviceId: String, memberId: String, callId: String, displayId: UInt32, mode: String,
    expiresAt: Date, protocolVersion: Int? = nil, sessionId: String? = nil,
    executorEpoch: Int? = nil, policyRevision: Int? = nil, executor: String? = nil
  ) {
    self.id = id
    self.deviceId = deviceId
    self.memberId = memberId
    self.callId = callId
    self.displayId = displayId
    self.mode = mode
    self.expiresAt = expiresAt
    self.protocolVersion = protocolVersion
    self.sessionId = sessionId
    self.executorEpoch = executorEpoch
    self.policyRevision = policyRevision
    self.executor = executor
  }
}
public struct FrameStamp {
  public let id: String
  public let leaseId: String
  public let displayId: UInt32
  public let capturedAt: Date
  public let width: Int
  public let height: Int
  public init(
    id: String, leaseId: String, displayId: UInt32, capturedAt: Date, width: Int, height: Int
  ) {
    self.id = id
    self.leaseId = leaseId
    self.displayId = displayId
    self.capturedAt = capturedAt
    self.width = width
    self.height = height
  }
}
public struct InputAction: Codable {
  public var id: String
  public var frameId: String
  public var type: String
  public var x: Double?
  public var y: Double?
  public var text: String?
  public var deltaY: Int32?
  public var executorEpoch: Int?
  public var policyRevision: Int?
  public var sessionId: String?
  public init(
    id: String, frameId: String, type: String, x: Double? = nil, y: Double? = nil,
    text: String? = nil, deltaY: Int32? = nil, executorEpoch: Int? = nil,
    policyRevision: Int? = nil, sessionId: String? = nil
  ) {
    self.id = id
    self.frameId = frameId
    self.type = type
    self.x = x
    self.y = y
    self.text = text
    self.deltaY = deltaY
    self.executorEpoch = executorEpoch
    self.policyRevision = policyRevision
    self.sessionId = sessionId
  }
  public func validate() throws {
    guard validID(id), validID(frameId) else { throw HelperError(400, "Invalid action identity.") }
    let point =
      x.map { $0.isFinite && (0...1).contains($0) } == true
      && y.map { $0.isFinite && (0...1).contains($0) } == true
    switch type {
    case "click":
      guard point && text == nil && deltaY == nil else {
        throw HelperError(400, "Click needs normalized x and y.")
      }
    case "type":
      guard let text, !text.isEmpty, text.utf16.count <= 512,
        !text.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
        x == nil, y == nil, deltaY == nil
      else { throw HelperError(400, "Type requires at most 512 printable UTF-16 characters.") }
    case "scroll":
      guard let deltaY, (-500...500).contains(deltaY), deltaY != 0, point, text == nil else {
        throw HelperError(400, "Scroll needs normalized x/y and deltaY between -500 and 500.")
      }
    default: throw HelperError(400, "Unsupported input action.")
    }
  }
}

/// Main-thread owner in the app. Pure authorization logic for deterministic tests.
public final class DevicePolicy {
  public let config: HelperConfig
  public private(set) var preferences: ControlPreferences
  public private(set) var armed = false
  public private(set) var lease: Lease?
  public private(set) var frame: FrameStamp?
  public private(set) var generation = 0
  private var retired = Set<String>()
  public init(config: HelperConfig, preferences: ControlPreferences? = nil) throws {
    try config.validate()
    self.config = config
    self.preferences = preferences ?? ControlPreferences(deviceId: config.deviceId)
    guard self.preferences.deviceId == config.deviceId, self.preferences.revision > 0 else {
      throw HelperError(403, "Local policy binding is invalid.")
    }
  }
  public func updatePreferences(_ next: ControlPreferences) throws {
    guard next.deviceId == config.deviceId, next.revision > preferences.revision else {
      throw HelperError(409, "Local policy revision must advance.")
    }
    stop(disarm: true)
    preferences = next
  }
  public func arm() { armed = true }
  public func stop(disarm: Bool = false) {
    if let lease { retired.insert(lease.id) }
    lease = nil
    frame = nil
    generation += 1
    if disarm { armed = false }
  }
  public func check(now: Date, sessionAvailable: Bool) throws {
    if !sessionAvailable {
      stop(disarm: true)
      throw HelperError(423, "Mac is locked, asleep or not in the active user session.")
    }
    guard armed else {
      throw HelperError(423, "Sharing is stopped locally. Enable it on the Mac first.")
    }
    if let lease, lease.expiresAt <= now {
      stop()
      throw HelperError(410, "Lease expired. A fresh request is required.")
    }
  }
  private func authorize(_ proposed: Lease, now: Date, accessibility: Bool) throws {
    guard proposed.deviceId == config.deviceId,
      [proposed.id, proposed.memberId, proposed.callId].allSatisfy(validID),
      ["view", "control"].contains(proposed.mode), proposed.expiresAt > now,
      proposed.expiresAt.timeIntervalSince(now) <= 30
    else { throw HelperError(400, "Invalid lease binding or expiration (maximum 30 seconds).") }
    guard let permission = config.displays.first(where: { $0.displayId == proposed.displayId }),
      permission.viewers.contains(proposed.memberId)
    else { throw HelperError(403, "Viewing this display is not authorized.") }
    let versionFields = [proposed.sessionId != nil, proposed.executorEpoch != nil,
                         proposed.policyRevision != nil, proposed.executor != nil]
    if proposed.protocolVersion == 2 {
      guard let sessionId = proposed.sessionId, validID(sessionId),
        let epoch = proposed.executorEpoch, epoch >= 0,
        proposed.policyRevision == preferences.revision,
        ["none", "native", "clawdtime"].contains(proposed.executor ?? ""),
        proposed.mode != "control" || proposed.executor == "clawdtime",
        preferences.policy != .viewOnly || proposed.executor == "none"
      else { throw HelperError(403, "Current session, executor and local policy are required.") }
    } else if proposed.protocolVersion != nil || versionFields.contains(true) {
      throw HelperError(400, "Unsupported lease protocol.")
    }
    if proposed.protocolVersion == 2 && proposed.executor != "none"
      && !permission.controllers.contains(proposed.memberId) {
      throw HelperError(403, "Computer control requires this display's local controller permission.")
    }
    if proposed.mode == "control" && preferences.policy != .agentToolsWithFallback {
      throw HelperError(403, "ClawdTime fallback is disabled locally.")
    }
    if proposed.mode == "control"
      && (!permission.controllers.contains(proposed.memberId) || !accessibility)
    {
      throw HelperError(403, "Control requires separate local permission and Accessibility access.")
    }
  }
  public func begin(_ proposed: Lease, now: Date, sessionAvailable: Bool, accessibility: Bool)
    throws
  {
    try check(now: now, sessionAvailable: sessionAvailable)
    try authorize(proposed, now: now, accessibility: accessibility)
    guard !retired.contains(proposed.id) else {
      throw HelperError(409, "A stopped lease cannot be resumed.")
    }
    if let lease {
      guard lease == proposed else {
        throw HelperError(409, "Stop the existing selected screen before starting another lease.")
      }
      return
    }
    lease = proposed
    frame = nil
    generation += 1
  }
  public func renew(_ proposed: Lease, now: Date, sessionAvailable: Bool, accessibility: Bool)
    throws
  {
    try check(now: now, sessionAvailable: sessionAvailable)
    guard var current = lease else { throw HelperError(410, "No active lease.") }
    current.expiresAt = proposed.expiresAt
    if current.protocolVersion == 2 && proposed.protocolVersion == 2,
      let nextEpoch = proposed.executorEpoch, let previousEpoch = current.executorEpoch,
      nextEpoch > previousEpoch {
      current.executorEpoch = nextEpoch
      current.executor = proposed.executor
      current.mode = proposed.mode
      current.policyRevision = proposed.policyRevision
    }
    guard current == proposed else {
      throw HelperError(409, "Renewal cannot change the lease owner, call, mode or display.")
    }
    try authorize(proposed, now: now, accessibility: accessibility)
    if lease?.executorEpoch != proposed.executorEpoch || lease?.mode != proposed.mode {
      frame = nil
      generation += 1
    }
    lease = proposed
  }
  public func requireLease(_ id: String, now: Date, sessionAvailable: Bool) throws -> Lease {
    try check(now: now, sessionAvailable: sessionAvailable)
    guard let lease, lease.id == id else { throw HelperError(404, "No matching active lease.") }
    return lease
  }
  public func invalidateFrame() { frame = nil }
  public func recordFrame(_ value: FrameStamp) throws {
    guard let lease, lease.id == value.leaseId, lease.displayId == value.displayId else {
      throw HelperError(409, "Frame belongs to an old lease.")
    }
    frame = value
  }
  public func validateAction(
    _ action: InputAction, leaseId: String, now: Date, sessionAvailable: Bool, accessibility: Bool
  ) throws -> Lease {
    let lease = try requireLease(leaseId, now: now, sessionAvailable: sessionAvailable)
    try authorize(lease, now: now, accessibility: accessibility)
    guard lease.mode == "control" else {
      throw HelperError(403, "Viewing does not authorize input.")
    }
    if lease.protocolVersion == 2 {
      guard action.executorEpoch == lease.executorEpoch, action.policyRevision == lease.policyRevision,
        action.sessionId == lease.sessionId, lease.executor == "clawdtime" else {
        throw HelperError(409, "Input belongs to an old computer-control owner.")
      }
    } else if action.executorEpoch != nil || action.policyRevision != nil || action.sessionId != nil {
      throw HelperError(409, "Input protocol does not match this lease.")
    }
    try action.validate()
    guard let frame, frame.id == action.frameId, frame.leaseId == leaseId,
      frame.displayId == lease.displayId, now.timeIntervalSince(frame.capturedAt) >= 0,
      now.timeIntervalSince(frame.capturedAt) <= 2
    else {
      throw HelperError(409, "Input requires the current frame, captured within two seconds.")
    }
    return lease
  }
}
