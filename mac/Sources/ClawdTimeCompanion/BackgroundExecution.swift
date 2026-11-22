import AppKit
import ApplicationServices
import DeviceCore
import Security

private struct DriverRequest: Decodable { let pid: Int32 }
private struct DriverWitness: Encodable {
  let pid: Int32
  let bundleId: String
  let processStart: String
}
private struct ApplicationRequest: Decodable { let bundleId: String }
private struct ApplicationWitness: Encodable { let bundleId: String; let bundleVersion: String; let executablePath: String }
private struct TargetRequest: Decodable { let bundleId: String; let pid: Int32; let windowId: UInt32 }
private struct TargetGeometry: Codable { let x: Double; let y: Double; let width: Double; let height: Double }
private struct TargetWitness: Encodable {
  let bundleId: String; let pid: Int32; let windowId: UInt32
  let processStart: String; let bundleVersion: String; let executablePath: String
  let onCurrentSpace: Bool; let geometry: TargetGeometry; let geometryGeneration: String
}
private struct GeometryIdentity: Encodable { let processStart: String; let windowId: UInt32; let geometry: TargetGeometry }
private struct ReservationReply: Encodable { let admitted: Bool; let receipt: BackgroundControllerReceipt }

/// Distinct background identity checks: no foreground/occlusion exceptions are
/// added to the native adapter. These routes never launch apps or submit input.
extension DeviceApp {
  private func signedApplication(_ pid: Int32, bundleId: String, exactPath: String? = nil) throws -> NSRunningApplication {
    guard pid > 0, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
      app.bundleIdentifier == bundleId, let bundleURL = app.bundleURL,
      let installedURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleId),
      bundleURL.resolvingSymlinksInPath() == installedURL.resolvingSymlinksInPath(),
      exactPath == nil || bundleURL.path == exactPath else {
      throw HelperError(409, "Background application identity is unavailable or changed.")
    }
    var code: SecCode?
    let attributes = [kSecGuestAttributePid as String: pid] as CFDictionary
    guard SecCodeCopyGuestWithAttributes(nil, attributes, [], &code) == errSecSuccess, let code else {
      throw HelperError(409, "Background process signature is unavailable.")
    }
    var requirement: SecRequirement?
    let expression = bundleId == "com.trycua.driver"
      ? "anchor apple generic and identifier \"com.trycua.driver\" and certificate leaf[subject.OU] = \"YCK386LBJ7\""
      : "anchor apple generic"
    guard SecRequirementCreateWithString(expression as CFString, [], &requirement) == errSecSuccess,
      SecCodeCheckValidity(code, [], requirement) == errSecSuccess else {
      throw HelperError(403, "Background application does not match its trusted signature.")
    }
    return app
  }
  private func processStart(_ app: NSRunningApplication) throws -> String {
    guard let bundle = app.bundleIdentifier,
      let lifetime = ProcessLifetimeIdentity.resolveLive(pid: app.processIdentifier, bundleId: bundle, launchTime: nil) else {
      throw HelperError(409, "Background process lifetime could not be verified.")
    }
    return try fingerprint(lifetime.stableMaterial)
  }
  private func driverWitness(_ pid: Int32) throws -> DriverWitness {
    let app = try signedApplication(pid, bundleId: "com.trycua.driver", exactPath: "/Applications/CuaDriver.app")
    guard let url = app.bundleURL, Bundle(url: url)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "0.55.0" else {
      throw HelperError(409, "Background driver release does not match the qualified pin.")
    }
    return DriverWitness(pid: pid, bundleId: "com.trycua.driver", processStart: try processStart(app))
  }
  func backgroundDriver(_ request: HTTPRequest) throws -> HTTPResponse {
    let value = try decode(DriverRequest.self, request.body)
    return try .json(driverWitness(value.pid))
  }
  func handleBackground(_ request: HTTPRequest, parts: [String], leaseId: String) throws -> HTTPResponse {
    if parts.count == 6, parts[4] == "background-actions", validID(parts[5]), request.method == "GET" {
      return try .json(backgroundLedger.get(parts[5], leaseId: leaseId))
    }
    if parts.count == 7, parts[4] == "background-actions", validID(parts[5]), parts[6] == "retire-navigation", request.method == "POST" {
      // Separate operator cleanup, never worker.close or input authorization.
      // Runtime operator validates the immutable linked action manifest first.
      let value = try decode(BackgroundControllerNavigationRetirement.self, request.body)
      return try .json(backgroundLedger.retireNavigation(parts[5], leaseId: leaseId, value: value, now: Date()))
    }
    if parts.count == 7, parts[4] == "background-actions", validID(parts[5]), parts[6] == "resolve", request.method == "POST" {
      // Cleanup remains possible after local Stop/expiry. The exact retained
      // receipt and explicit quiescence evidence are required; no input occurs.
      let value = try decode(BackgroundControllerResolution.self, request.body)
      return try .json(backgroundLedger.resolve(parts[5], leaseId: leaseId, value: value, now: Date()))
    }
    let lease = try localPolicy.require(leaseId, now: Date(), available: localExecutionAvailable)
    guard AXIsProcessTrusted(), policy.armed else { throw HelperError(403, "Local control is not enabled.") }
    if parts.count == 5, parts[4] == "background-actions", request.method == "POST" {
      let value = try decode(BackgroundControllerReservation.self, request.body)
      try value.validate()
      if let old = try backgroundLedger.existing(value, leaseId: leaseId) {
        return try .json(ReservationReply(admitted: false, receipt: old))
      }
      guard unresolvedInputCount == 0 else { throw HelperError(409, "Reconcile all input before reserving a background controller.") }
      let driver = try driverWitness(value.driverPid)
      guard driver.processStart == value.driverProcessStart else { throw HelperError(409, "Background driver process was replaced.") }
      let receipt = try backgroundLedger.reserve(value, lease: lease, now: Date())
      return try .json(ReservationReply(admitted: true, receipt: receipt))
    }
    if parts.count == 5, parts[4] == "background-application", request.method == "POST" {
      let value = try decode(ApplicationRequest.self, request.body)
      let allowed = config.localExecutors?.first { $0.executorId == lease.executorId && $0.displayId == lease.displayId }?.allowedApplications ?? []
      guard allowed.contains(value.bundleId), let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: value.bundleId),
        let bundle = Bundle(url: url), bundle.bundleIdentifier == value.bundleId, let executable = bundle.executableURL else {
        throw HelperError(403, "Background application is not allowlisted or installed.")
      }
      var code: SecStaticCode?; var requirement: SecRequirement?
      guard SecStaticCodeCreateWithPath(url as CFURL, [], &code) == errSecSuccess, let code,
        SecRequirementCreateWithString("anchor apple generic" as CFString, [], &requirement) == errSecSuccess,
        SecStaticCodeCheckValidity(code, [], requirement) == errSecSuccess else {
        throw HelperError(403, "Background application signature is unavailable.")
      }
      return try .json(ApplicationWitness(bundleId: value.bundleId,
        bundleVersion: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown",
        executablePath: executable.path))
    }
    if parts.count == 5, parts[4] == "background-target", request.method == "POST" {
      let value = try decode(TargetRequest.self, request.body)
      let allowed = config.localExecutors?.first { $0.executorId == lease.executorId && $0.displayId == lease.displayId }?.allowedApplications ?? []
      guard allowed.contains(value.bundleId), value.windowId > 0 else { throw HelperError(403, "Background target is not allowlisted.") }
      let app = try signedApplication(value.pid, bundleId: value.bundleId)
      guard let executable = app.executableURL, let bundleURL = app.bundleURL,
        let windows = CGWindowListCopyWindowInfo(.optionIncludingWindow, value.windowId) as? [[String: Any]],
        let window = windows.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == value.windowId }),
        (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == value.pid,
        let raw = window[kCGWindowBounds as String] as? [String: Any],
        let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds.width > 0, bounds.height > 0,
        [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height].allSatisfy({ $0.isFinite }) else {
        throw HelperError(409, "Exact background window is unavailable or changed.")
      }
      let start = try processStart(app)
      let geometry = TargetGeometry(x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height)
      let generation = try fingerprint(GeometryIdentity(processStart: start, windowId: value.windowId, geometry: geometry))
      let version = Bundle(url: bundleURL)?.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
      return try .json(TargetWitness(bundleId: value.bundleId, pid: value.pid, windowId: value.windowId,
        processStart: start, bundleVersion: version, executablePath: executable.path,
        onCurrentSpace: (window[kCGWindowIsOnscreen as String] as? Bool) == true,
        geometry: geometry, geometryGeneration: generation))
    }
    throw HelperError(404, "Unknown background route.")
  }
}
