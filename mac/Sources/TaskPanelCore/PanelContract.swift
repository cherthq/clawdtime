import Foundation

public enum PanelFailure: Error, LocalizedError {
  case configuration, privateStorage, alreadyOpen, differentPanel, response, unavailable, unresolved
  public var errorDescription: String? {
    switch self {
    case .configuration: return "This panel needs a valid private ClawdTime configuration."
    case .privateStorage: return "Private panel receipts are unavailable. No action was sent."
    case .alreadyOpen: return "This ClawdTime panel is already open. Use its menu to show the window."
    case .differentPanel: return "Another panel configuration owns this private state. Quit that panel before switching; its service keeps running."
    case .response: return "The service response could not be confirmed."
    case .unavailable: return "The task service is unavailable. Existing work continues independently."
    case .unresolved: return "An earlier request is unconfirmed. Checking its receipt; it will not be repeated."
    }
  }
}

public struct PanelConfiguration: Codable, Equatable {
  public let version: Int
  public let desktopId: String
  public let origin: String
  public let token: String
  public let projectRoot: String
  public let receiptDirectory: String
  public let configurationFingerprint: String
  public var boundTaskId: String? = nil

  public func validate(configPath: URL) throws {
    guard version == 1, Self.identity(desktopId), boundTaskId.map(Self.identity) ?? true, (32...4096).contains(token.count),
      token.unicodeScalars.allSatisfy({ $0.value >= 33 && $0.value <= 126 }),
      configurationFingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
      let url = URLComponents(string: origin), url.scheme == "http", url.host == "127.0.0.1",
      let port = url.port, (1024...65535).contains(port), url.path.isEmpty,
      url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
      projectRoot.hasPrefix("/"), receiptDirectory.hasPrefix("/"),
      projectRoot.count <= 4096, receiptDirectory.count <= 4096 else { throw PanelFailure.configuration }
    let root = URL(fileURLWithPath: projectRoot).resolvingSymlinksInPath().standardizedFileURL.path
    for path in [configPath, URL(fileURLWithPath: receiptDirectory)] {
      let absolute = path.resolvingSymlinksInPath().standardizedFileURL.path
      guard absolute != root, !absolute.hasPrefix(root + "/") else { throw PanelFailure.configuration }
    }
  }
  public static func identity(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9_-]{1,200}$", options: .regularExpression) != nil
  }
}

public enum PanelAction: String, Codable, CaseIterable {
  case submit, decide, accept, cancel, callback, stopSharing = "stop_sharing", stopCall = "stop_call"
  public var isStop: Bool { self == .stopSharing || self == .stopCall }
  public var label: String {
    switch self {
    case .submit: return "Start task"
    case .decide: return "Send answer"
    case .accept: return "Accept result"
    case .cancel: return "Cancel task"
    case .callback: return "Request review callback"
    case .stopSharing: return "Stop sharing"
    case .stopCall: return "Stop call"
    }
  }
}
public struct PanelOperation: Codable, Equatable {
  public let eventId: String
  public let action: PanelAction?
  public let state: String
  public let message: String
  public let taskId: String?
  public let resultRevision: Int?
  public var resolved: Bool { state == "done" || state == "refused" }
  public func validate() throws {
    guard PanelConfiguration.identity(eventId), ["pending", "done", "refused", "unknown", "not_found"].contains(state),
      message.count <= 8000, state == "not_found" || action != nil,
      resultRevision.map({ $0 >= 0 }) ?? true else { throw PanelFailure.response }
  }
}
public struct PanelTask: Codable, Equatable {
  public struct Decision: Codable, Equatable {
    public let question: String
    public let options: [String]?
    public func validate() throws {
      guard !question.isEmpty, question.count <= 8000,
        options.map({ (2...3).contains($0.count) && $0.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 500 }) }) ?? true else { throw PanelFailure.response }
    }
  }
  public struct Check: Codable, Equatable { public let name: String; public let state: String; public let summary: String }
  public let id: String
  public let runId: String
  public let revision: Int
  public let goal: String
  public let state: String
  public let summary: String
  public let decision: Decision?
  public let checks: [Check]
  public let canDecide: Bool
  public let canAccept: Bool
  public let canCancel: Bool
  public let updatedAt: Double
}
public struct PanelSnapshot: Codable, Equatable {
  public struct CallFlow: Codable, Equatable {
    public let state: String
    public let message: String
    public func validate() throws {
      guard state.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil,
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, message.count <= 2000,
        !message.unicodeScalars.contains(where: { $0.value < 32 && $0 != "\n" && $0 != "\t" }) else { throw PanelFailure.response }
    }
  }
  public struct Controls: Codable, Equatable {
    public let controlId: String?
    public let sharingActive: Bool
    public let callActive: Bool
    public let canStopSharing: Bool
    public let canStopCall: Bool
  }
  public let version: Int
  public let desktopId: String
  public let instanceId: String
  public let configurationFingerprint: String
  public let projectRoot: String
  public let projectLabel: String
  public let worker: String
  public let mode: String
  public let sessionExpiresAt: Double
  public let sessionActive: Bool?
  public let notice: String?
  public let canSubmit: Bool
  public let task: PanelTask?
  public let controls: Controls
  public let operations: [PanelOperation]
  public let callFlow: CallFlow?

  public func validate(configuration: PanelConfiguration) throws {
    guard version == 1, desktopId == configuration.desktopId, PanelConfiguration.identity(instanceId),
      configurationFingerprint == configuration.configurationFingerprint, projectRoot == configuration.projectRoot,
      !projectLabel.isEmpty, projectLabel.count <= 500, ["simulation", "codex"].contains(worker),
      ["simulation", "standby"].contains(mode), sessionExpiresAt.isFinite, sessionExpiresAt > 0,
      operations.count <= 1024, (notice?.count ?? 0) <= 8000,
      controls.controlId.map(PanelConfiguration.identity) ?? !(controls.canStopCall || controls.canStopSharing) else { throw PanelFailure.response }
    if let task {
      guard configuration.boundTaskId.map({ $0 == task.id }) ?? true,
        PanelConfiguration.identity(task.id), PanelConfiguration.identity(task.runId), task.revision >= 0,
        !task.goal.isEmpty, task.goal.count <= 8000, task.state.count <= 100, task.summary.count <= 32000,
        (task.decision?.question.count ?? 0) <= 8000, task.checks.count <= 100,
        task.checks.allSatisfy({ $0.name.count <= 500 && $0.state.count <= 100 && $0.summary.count <= 8000 }),
        task.updatedAt.isFinite else { throw PanelFailure.response }
    }
    try callFlow?.validate()
    try task?.decision?.validate()
    for operation in operations { try operation.validate() }
  }
}

public struct PendingPanelOperation: Codable, Equatable {
  public let eventId: String
  public let digest: String
  public let action: PanelAction
  public var state: String
  public let createdAt: Double
  public var unresolved: Bool { state != "done" && state != "refused" }
}

public struct PanelState {
  public var snapshot: PanelSnapshot?
  public var connected = false
  public private(set) var mutationGeneration = 0
  public private(set) var waitingForSnapshot = false
  public var pending: [PendingPanelOperation] = []
  public init() {}
  public mutating func taskMutationBoundary(_ action: PanelAction) {
    guard !action.isStop else { return }
    mutationGeneration += 1; waitingForSnapshot = true
  }
  public mutating func receive(_ value: PanelSnapshot, readGeneration: Int) {
    snapshot = value; connected = true
    if readGeneration == mutationGeneration { waitingForSnapshot = false }
  }
  public var hasTaskRequest: Bool {
    pending.contains { $0.unresolved && !$0.action.isStop } ||
      (snapshot?.operations.contains { !$0.resolved && !($0.action?.isStop ?? false) } ?? false)
  }
  public func allows(_ action: PanelAction, now: Double = Date().timeIntervalSince1970 * 1000) -> Bool {
    guard let snapshot else { return false }
    if action.isStop {
      guard snapshot.controls.controlId != nil,
        !pending.contains(where: { $0.unresolved && $0.action == action }),
        !snapshot.operations.contains(where: { !$0.resolved && $0.action == action }) else { return false }
      return action == .stopCall ? snapshot.controls.canStopCall : snapshot.controls.canStopSharing
    }
    guard connected, !waitingForSnapshot, snapshot.sessionExpiresAt > now, !hasTaskRequest else { return false }
    switch action {
    case .submit: return snapshot.canSubmit
    case .decide: return snapshot.task?.canDecide ?? false
    case .accept: return snapshot.task?.canAccept ?? false
    case .cancel: return snapshot.task?.canCancel ?? false
    default: return false
    }
  }
  public func payload(_ action: PanelAction, text: String = "", eventId: String) throws -> [String: Any] {
    guard allows(action), PanelConfiguration.identity(eventId), let snapshot else { throw PanelFailure.unresolved }
    var result: [String: Any] = ["eventId": eventId, "action": action.rawValue]
    if action.isStop {
      result["controlId"] = snapshot.controls.controlId!
    } else if action == .submit {
      guard (1...8000).contains(text.count), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PanelFailure.configuration }
      result["goal"] = text
    } else {
      guard let task = snapshot.task else { throw PanelFailure.unresolved }
      result["taskId"] = task.id; result["runId"] = task.runId; result["expectedRevision"] = task.revision
      if action == .decide {
        guard (1...8000).contains(text.count), !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw PanelFailure.configuration }
        result["instruction"] = text
      }
    }
    return result
  }
  /// Selecting a genuine worker option only returns editor text; it reserves no operation.
  public func decisionOption(at index: Int) -> String? {
    guard allows(.decide), let options = snapshot?.task?.decision?.options, options.indices.contains(index) else { return nil }
    return options[index]
  }
  public var callStatus: String {
    if snapshot?.controls.callActive == true {
      return snapshot?.controls.sharingActive == true ? "Call active · sharing" : "Call active"
    }
    if snapshot?.controls.sharingActive == true { return "Sharing active" }
    return snapshot?.callFlow?.message ?? "No active call"
  }
  public var stage: String {
    guard let task = snapshot?.task else { return "Ready when you are" }
    switch task.state {
    case "queued": return snapshot?.worker == "simulation" ? "Queued · simulation" : "Queued"
    case "running": return "Working on your task"
    case "verifying": return "Checking the result"
    case "needs_decision": return "Your input is needed"
    case "review_ready", "review_call": return "Ready for your review"
    case "accepted": return "Result accepted"
    case "cancelRequested", "cancel_requested": return "Cancellation requested"
    case "canceled": return "Task canceled"
    case "failed": return "The task needs attention"
    case "blocked": return "Waiting for a next step"
    case "unknown": return "Outcome unconfirmed"
    default: return task.state.replacingOccurrences(of: "_", with: " ").capitalized
    }
  }
}
