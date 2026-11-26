import Foundation

/// A proposal never grants authority. Only approveTextGrant(), invoked by local UI,
/// activates this ephemeral binding. Dates are milliseconds for the broker wire.
public struct TextControlGrant: Codable, Equatable {
  public var id: String
  public var kind: String
  public var sessionId: String
  public var pairingId: String
  public var memberId: String
  public var deviceId: String
  public var displayId: String
  public var projectRoot: String
  public var surface: String
  public var actions: [String]
  public var expiresAt: Double
  public var policyRevision: Int
  public var localEnableGeneration: Int
  public var state: String

  public func validate(now: Date) throws {
    guard [id, sessionId, pairingId, memberId, deviceId].allSatisfy(validID),
      kind == "text_session", state == "active", UInt32(displayId) != nil,
      displayId == String(UInt32(displayId)!), projectRoot.hasPrefix("/"),
      projectRoot.utf8.count <= 1024,
      !projectRoot.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
      surface == "display:" + displayId, !actions.isEmpty, actions.count <= 3,
      Set(actions).count == actions.count, actions.allSatisfy({ ["click", "type", "scroll"].contains($0) }),
      expiresAt.isFinite, expiresAt > now.timeIntervalSince1970 * 1000,
      expiresAt <= now.timeIntervalSince1970 * 1000 + 900_000,
      policyRevision > 0, localEnableGeneration >= 0
    else { throw HelperError(400, "Invalid scoped text-control proposal.") }
  }
}

public struct TextLeaseAuthority: Codable, Equatable {
  public var kind: String
  public var grantId: String
  public var projectId: String
  public init(kind: String = "text_session", grantId: String, projectId: String) {
    self.kind = kind; self.grantId = grantId; self.projectId = projectId
  }
}
