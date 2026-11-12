import Foundation

public struct PanelTelemetry: Codable {
  public let sessionId: String
  public let callId: String
  public let memberId: String
  public let displayId: UInt32
  public let expiresAt: Date
  public let agent: String
  public let projectLabel: String?
  public let personLabel: String?
  public let callState: String
  public let executionState: String
  public let executor: String
  public let executorEpoch: Int
  public let policyRevision: Int
  public let acknowledgedCommandId: String?
}
public struct PanelCommand: Codable, Equatable {
  public let id: String
  public let sessionId: String
  public let callId: String
  public let type: String
}

/// Transient status is descriptive only. A remote status update cannot grant input.
public final class ControlPanelState {
  public private(set) var telemetry: PanelTelemetry?
  public private(set) var command: PanelCommand?
  public private(set) var retiredCommands: [PanelCommand] = []
  public init() {}
  public func update(_ next: PanelTelemetry, lease: Lease?, now: Date) throws {
    let bound: Bool
    if let lease {
      bound = lease.protocolVersion == 2 && next.sessionId == lease.sessionId
        && next.callId == lease.callId && next.memberId == lease.memberId
        && next.displayId == lease.displayId && next.executor == lease.executor
        && next.executorEpoch == lease.executorEpoch && next.policyRevision == lease.policyRevision
    } else if let previous = telemetry {
      // Call controls survive Stop; this status cannot create a lease or input grant.
      bound = next.sessionId == previous.sessionId && next.callId == previous.callId
        && next.memberId == previous.memberId && next.displayId == previous.displayId
        && next.executorEpoch >= previous.executorEpoch
    } else { bound = false }
    guard bound, next.expiresAt > now,
      ["none", "native", "clawdtime"].contains(next.executor), next.executorEpoch >= 0,
      next.expiresAt.timeIntervalSince(now) <= 30,
      ["codex", "claude-code"].contains(next.agent),
      ["connected", "listening", "speaking", "muted", "ended"].contains(next.callState),
      ["working", "waiting", "pending_approval", "uncertain"].contains(next.executionState),
      next.projectLabel.map({ $0.utf8.count <= 160 && !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }) ?? true,
      next.personLabel.map({ !$0.isEmpty && $0.utf8.count <= 80 && !$0.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) }) ?? true
    else { throw HelperError(409, "Panel status requires the current sharing session.") }
    if let command, command.sessionId == next.sessionId, command.callId == next.callId,
      command.id == next.acknowledgedCommandId { self.command = nil }
    if let command, command.sessionId != next.sessionId || command.callId != next.callId {
      // A new exact lease must not inherit a previous call's local controls.
      // Retain unresolved identities for inspection; never replay them on the new call.
      guard retiredCommands.count < 32 else {
        throw HelperError(409, "Prior call controls need reconciliation before accepting more status.")
      }
      retiredCommands.append(command)
      self.command = nil
    }
    telemetry = next
  }
  public func current(now: Date) -> PanelTelemetry? {
    guard let telemetry, telemetry.expiresAt > now else { return nil }
    return telemetry
  }
  public func request(_ type: String, now: Date) throws {
    guard ["pause", "mute", "unmute", "end"].contains(type), let current = current(now: now), current.callState != "ended" else {
      throw HelperError(409, "A connected call is required for this control.")
    }
    guard command == nil else { throw HelperError(409, "A previous call control is awaiting acknowledgement.") }
    command = PanelCommand(id: UUID().uuidString, sessionId: current.sessionId, callId: current.callId, type: type)
  }
}
