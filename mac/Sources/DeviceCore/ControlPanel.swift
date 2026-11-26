import Foundation

private func forbiddenPresentationScalar(_ scalar: Unicode.Scalar) -> Bool {
  scalar.properties.generalCategory == .control || scalar.properties.generalCategory == .surrogate
}

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
  public let presentationVersion: Int?
  public var activity: PanelActivity?
  public var readiness: PanelReadiness?
  private enum CodingKeys: String, CodingKey {
    case sessionId, callId, memberId, displayId, expiresAt, agent, projectLabel, personLabel,
      callState, executionState, executor, executorEpoch, policyRevision, acknowledgedCommandId,
      presentationVersion, activity, readiness
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    sessionId = try c.decode(String.self, forKey: .sessionId)
    callId = try c.decode(String.self, forKey: .callId)
    memberId = try c.decode(String.self, forKey: .memberId)
    displayId = try c.decode(UInt32.self, forKey: .displayId)
    expiresAt = try c.decode(Date.self, forKey: .expiresAt)
    agent = try c.decode(String.self, forKey: .agent)
    projectLabel = try c.decodeIfPresent(String.self, forKey: .projectLabel)
    personLabel = try c.decodeIfPresent(String.self, forKey: .personLabel)
    callState = try c.decode(String.self, forKey: .callState)
    executionState = try c.decode(String.self, forKey: .executionState)
    executor = try c.decode(String.self, forKey: .executor)
    executorEpoch = try c.decode(Int.self, forKey: .executorEpoch)
    policyRevision = try c.decode(Int.self, forKey: .policyRevision)
    acknowledgedCommandId = try c.decodeIfPresent(String.self, forKey: .acknowledgedCommandId)
    presentationVersion = try? c.decode(Int.self, forKey: .presentationVersion)
    activity = try? c.decode(PanelActivity.self, forKey: .activity)
    readiness = try? c.decode(PanelReadiness.self, forKey: .readiness)
  }

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
  private var activitySequence = -1
  private var activityReceivedAt = Date.distantPast
  private var suppressedCall: String?
  public init() {}
  /// Clears presentation immediately, preserving exact-call command reconciliation.
  public func clearActivity(stop: Bool = false) {
    if stop, let telemetry { suppressedCall = telemetry.sessionId + ":" + telemetry.callId }
    telemetry?.activity = nil
  }
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
      next.expiresAt.timeIntervalSince(now) <= (next.presentationVersion == 1 ? 5.1 : 30),
      ["codex", "claude-code"].contains(next.agent),
      ["connected", "listening", "speaking", "muted", "ended"].contains(next.callState),
      ["working", "waiting", "pending_approval", "uncertain"].contains(next.executionState),
      next.projectLabel.map({ $0.utf8.count <= 160 && !$0.unicodeScalars.contains(where: { forbiddenPresentationScalar($0) }) }) ?? true,
      next.personLabel.map({ !$0.isEmpty && $0.utf8.count <= 80 && !$0.unicodeScalars.contains(where: { forbiddenPresentationScalar($0) }) }) ?? true
    else { clearActivity(); throw HelperError(409, "Panel status requires the current sharing session.") }
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
    var accepted = next
    if let readiness = accepted.readiness, readiness.nextStep == nil || readiness.checkedAt > now.addingTimeInterval(5) || now.timeIntervalSince(readiness.checkedAt) > 30 { accepted.readiness = nil }
    let binding = next.sessionId + ":" + next.callId
    let same = telemetry?.sessionId == next.sessionId && telemetry?.callId == next.callId
    if !same { activitySequence = -1; activityReceivedAt = .distantPast }
    // Optional presentation failure never blocks a control acknowledgement.
    if next.presentationVersion != 1 || next.callState == "ended" || suppressedCall == binding {
      accepted.activity = nil
    } else if let activity = next.activity, activity.valid {
      if activity.sequence > activitySequence {
        activitySequence = activity.sequence
        activityReceivedAt = now
      } else {
        // An identical sequence cannot replace content or renew text lifetime.
        accepted.activity = telemetry?.activity
      }
      let lifetime: TimeInterval = accepted.activity?.outcome == nil ? 600 : 60
      if now.timeIntervalSince(activityReceivedAt) >= lifetime || (accepted.activity?.expiresAt.map { $0 <= now || $0.timeIntervalSince(now) > lifetime } ?? false) { accepted.activity = nil }
    } else { accepted.activity = nil }
    if ["agent_stale", "gateway_unavailable"].contains(accepted.readiness?.reason ?? "") { accepted.activity = nil }
    telemetry = accepted
  }
  public func current(now: Date) -> PanelTelemetry? {
    guard let telemetry else { return nil }
    guard telemetry.expiresAt > now else { clearActivity(); return nil }
    if now.timeIntervalSince(activityReceivedAt) >= (telemetry.activity?.outcome == nil ? 600 : 60) || (telemetry.activity?.expiresAt.map { $0 <= now } ?? false) {
      clearActivity()
    }
    return self.telemetry
  }
  public func request(_ type: String, now: Date) throws {
    guard ["pause", "mute", "unmute", "end"].contains(type), let current = current(now: now), current.callState != "ended" else {
      throw HelperError(409, "A connected call is required for this control.")
    }
    guard command == nil else { throw HelperError(409, "A previous call control is awaiting acknowledgement.") }
    command = PanelCommand(id: UUID().uuidString, sessionId: current.sessionId, callId: current.callId, type: type)
  }
}


public struct PanelActivityEntry: Codable {
  public let activityId: String
  public let sequence: Int
  public let kind: String
  public let summary: String?
}
public struct PanelOutcome: Codable {
  public let outcomeId: String
  public let status: String
  public let verification: String
  public let evidenceKind: String?
  public let summary: String?
}
public struct PanelActivity: Codable {
  public let version: Int
  public let sequence: Int
  public let delivery: String
  public let work: String
  public let entries: [PanelActivityEntry]
  public let currentSummary: String?
  public let outcome: PanelOutcome?
  public let expiresAt: Date?
  private func text(_ value: String?) -> Bool {
    value.map { !$0.isEmpty && $0.unicodeScalars.count <= 160 && $0.utf8.count <= 640 && !$0.unicodeScalars.contains(where: forbiddenPresentationScalar) } ?? true
  }
  private func id(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 160 && value.unicodeScalars.allSatisfy {
      CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-").contains($0)
    }
  }
  public var valid: Bool {
    guard version == 1, sequence >= 0, ["pending", "acknowledged"].contains(delivery),
      ["received", "executing", "pending_approval", "completed", "canceled", "uncertain"].contains(work),
      entries.count <= 20, text(currentSummary),
      entries.allSatisfy({ id($0.activityId) && $0.sequence >= 0 && $0.sequence <= sequence && ["status", "approval_needed", "outcome"].contains($0.kind) && text($0.summary) }),
      zip(entries, entries.dropFirst()).allSatisfy({ $0.sequence < $1.sequence }) else { return false }
    if let outcome {
      return id(outcome.outcomeId) && ["completed", "canceled", "uncertain"].contains(outcome.status)
        && outcome.status == work && ["agent_observed", "not_verified", "unknown"].contains(outcome.verification)
        && (outcome.evidenceKind.map { ["ui_observation", "test_result", "artifact"].contains($0) } ?? true)
        && text(outcome.summary)
    }
    return true
  }
}

/// Deterministic labels are descriptive, never approval or proof of application success.
public struct PanelPresentation {
  public let identity: String
  public let status: String
  public let detail: String
  public let currentSummary: String
  public let controlsEnabled: Bool
  public let muteTitle: String
  public init(telemetry: PanelTelemetry?, pending: PanelCommand?, sharing: String) {
    guard let t = telemetry else {
      identity = sharing
      status = "Status unavailable · check the connected agent"
      detail = "Task text cleared. Local Stop remains available."
      currentSummary = detail
      controlsEnabled = false; muteTitle = "Mute"; return
    }
    identity = "\(t.agent == "codex" ? "Codex" : "Claude Code") · \(t.projectLabel ?? "Current chat")\n\(sharing) · Display \(t.displayId)"
    let unavailable = ["agent_stale", "gateway_unavailable"].contains(t.readiness?.reason ?? "")
    let activity = unavailable ? nil : t.activity
    controlsEnabled = t.callState != "ended" && pending == nil && !unavailable
    muteTitle = t.callState == "muted" ? "Unmute" : "Mute"
    let work = activity?.work ?? t.executionState
    let labels = ["received":"Waiting", "waiting":"Waiting", "working":"Working", "executing":"Working", "pending_approval":"Waiting for native approval", "completed":"Agent reports completed", "canceled":"Canceled", "uncertain":"Outcome unresolved"]
    let outcome = activity?.outcome
    let state = t.executionState == "uncertain" || work == "uncertain" || outcome?.verification == "unknown" ? "Outcome unresolved" : outcome?.verification == "not_verified" ? "Outcome unverified" : labels[work] ?? "Status unavailable"
    let delivery = activity.map { $0.delivery == "acknowledged" ? "Received by agent" : "Accepted by backend" } ?? "Delivery status unavailable"
    let capture = ["listening":"Microphone listening", "muted":"Microphone muted", "speaking":"Microphone paused for speech", "ended":"Call ended"][t.callState] ?? "Microphone status pending"
    status = t.callState == "ended" ? "Call ended" : unavailable ? "Status unavailable · reconnect and recheck" : "\(state) · \(delivery)\n\(capture)" + (pending.map { "\n\($0.type.capitalized) request pending acknowledgement" } ?? "")
    let summaries = t.callState == "ended" ? [] : activity?.entries.compactMap(\.summary) ?? []
    let readiness = t.readiness?.nextStep ?? (work == "pending_approval" ? "Review the native approval in the coding client." : work == "uncertain" ? "Reconcile the prior effect before continuing." : nil)
    currentSummary = t.callState == "ended" ? "Task text cleared." : readiness ?? activity?.currentSummary ?? outcome?.summary ?? ""
    var lines = t.callState == "ended" ? [String]() : [outcome?.summary].compactMap { $0 } + summaries
    if outcome != nil && outcome?.summary == nil { lines.append("Outcome summary unavailable (cleared or expired).") }
    lines.append("Executor: \(t.executor) · Epoch \(t.executorEpoch) · Policy \(t.policyRevision)")
    if let readiness { lines.append("Next step: \(readiness)") }
    if let checked = t.readiness?.checkedAt { lines.append("Checked: \(ISO8601DateFormatter().string(from: checked))") }
    detail = lines.joined(separator: "\n")
  }
}


public struct PanelReadiness: Codable {
  public let reason: String
  public let checkedAt: Date
  public var nextStep: String? {
    ["agent_stale":"Reconnect the exact coding chat, then recheck status.",
     "sharing_disabled":"Choose Enable locally on the intended Mac when ready.",
     "screen_permission":"Grant Screen Recording in local Setup, then recheck.",
     "control_permission":"Grant Accessibility locally if control is intended.",
     "binding_mismatch":"Select the paired Mac and display in setup; recheck the exact chat.",
     "gateway_unavailable":"Check the paired gateway connection, then rerun doctor.",
     "native_approval":"Review the native approval in the coding client.",
     "unresolved_effect":"Reconcile the prior effect before continuing."][reason]
  }
}
