import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import DeviceCore
import ScreenCaptureKit

private func hash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func failure() -> NSError { NSError(domain: "task_capture_refused", code: 1) }
private struct ResolutionRefused: Error {
  let reason: String
  var geometry: [String: Any]? = nil
}
private func rectangle(_ value: CGRect) -> [String: Double] {
  ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
}
@MainActor private func preflight() -> [String: Bool] {
  let session = CGSessionCopyCurrentDictionary() as? [String: Any]
  return ["screenPermission": CGPreflightScreenCaptureAccess(),
    "onConsole": session?[kCGSessionOnConsoleKey as String] as? Bool == true,
    "loginComplete": session?[kCGSessionLoginDoneKey as String] as? Bool == true,
    "locked": session == nil || session?["CGSSessionScreenIsLocked"] as? Bool == true]
}
@MainActor private func lifetime(_ app: NSRunningApplication) -> String? {
  guard !app.isTerminated, let bundle = app.bundleIdentifier else { return nil }
  var identity = ProcessLifetimeIdentity.resolve(pid: app.processIdentifier, bundleId: bundle, launchTime: app.launchDate?.timeIntervalSince1970)
  if identity == nil {
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, app.processIdentifier]
    var info = kinfo_proc(); var size = MemoryLayout<kinfo_proc>.size
    guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0,
      size == MemoryLayout<kinfo_proc>.size, info.kp_proc.p_pid == app.processIdentifier else { return nil }
    let start = info.kp_proc.p_un.__p_starttime
    identity = ProcessLifetimeIdentity.resolve(pid: app.processIdentifier, bundleId: bundle, launchTime: nil,
      kernelPID: info.kp_proc.p_pid, kernelSeconds: Int64(start.tv_sec), kernelMicroseconds: Int64(start.tv_usec))
  }
  return identity.map { hash(Data($0.stableMaterial.utf8)) }
}

@MainActor private func available() -> Bool {
  let state = preflight()
  return state["screenPermission"] == true && state["onConsole"] == true && state["loginComplete"] == true && state["locked"] == false
}

/// Diagnostic only: compare the exact SCK ID with independent WindowServer
/// metadata. Neither witness changes admission or starts capture/Accessibility.
@MainActor private func windowWitness(_ window: SCWindow) -> [String: Any] {
  let exact = (CGWindowListCopyWindowInfo(.optionIncludingWindow, window.windowID) as? [[String: Any]] ?? [])
    .filter { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == window.windowID }
  let onScreenIDs = (CGWindowListCopyWindowInfo(.optionOnScreenOnly, kCGNullWindowID) as? [[String: Any]] ?? [])
    .compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value }
  var result: [String: Any] = ["bounds": rectangle(window.frame), "onScreen": window.isOnScreen,
    "layerZero": window.windowLayer == 0, "windowServerExactCount": min(exact.count, 1000000),
    "windowServerOnScreenListed": onScreenIDs.contains(window.windowID),
    "minimizedStatus": "not_queried_use_local_ui"]
  if let owner = window.owningApplication,
    let app = NSRunningApplication(processIdentifier: owner.processID) {
    result["appHidden"] = app.isHidden
    result["appTerminated"] = app.isTerminated
    result["appActive"] = app.isActive
  }
  if exact.count == 1, let item = exact.first {
    result["windowServerOnScreenFlag"] = item[kCGWindowIsOnscreen as String] as? Bool ?? false
    result["windowServerOwnerMatches"] = (item[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == window.owningApplication?.processID
    result["windowServerLayerZero"] = (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0
    result["windowServerTitleMatches"] = item[kCGWindowName as String] as? String == window.title
    if let bounds = item[kCGWindowBounds as String] as? NSDictionary,
      let rect = CGRect(dictionaryRepresentation: bounds) { result["windowServerBounds"] = rectangle(rect) }
  }
  return result
}

@MainActor private final class CaptureProfiler {
  private let start = ProcessInfo.processInfo.systemUptime
  private let enabled: Bool
  private var sequence = 0
  init() {
    let flags = fcntl(STDERR_FILENO, F_GETFL)
    enabled = flags >= 0 && fcntl(STDERR_FILENO, F_SETFL, flags | O_NONBLOCK) == 0
  }
  func phase(_ phase: TaskCaptureTiming.Phase) {
    guard enabled else { return }
    sequence = min(1_000_000, sequence + 1)
    let record = TaskCaptureTiming(phase: phase, elapsedMilliseconds: (ProcessInfo.processInfo.systemUptime - start) * 1000, sequence: sequence)
    if var data = try? JSONEncoder().encode(record) {
      data.append(10)
      // Tiny records are atomic on the pipe. Drop on EAGAIN/error rather than
      // letting optional telemetry stall capture or retry external work.
      guard data.count <= 128 else { return }
      _ = data.withUnsafeBytes { Darwin.write(STDERR_FILENO, $0.baseAddress, $0.count) }
    }
  }
}

@MainActor private func refuse(_ profiler: CaptureProfiler?, _ phase: TaskCaptureTiming.Phase) -> NSError {
  profiler?.phase(phase)
  return failure()
}

@MainActor private func inspect(_ target: TaskCaptureTarget, _ grant: TaskCaptureGrant, profiler: CaptureProfiler? = nil, after: Bool = false) async throws -> (SCWindow, CGRect, Int, Int) {
  profiler?.phase(after ? .afterGuard : .beforeGuard)
  guard available() else { throw refuse(profiler, .refusedAvailability) }
  guard grant.permits(target, now: Date().timeIntervalSince1970 * 1000) else { throw refuse(profiler, .refusedGrant) }
  guard CGDisplayIsActive(target.displayId) != 0 else { throw refuse(profiler, .refusedDisplay) }
  guard let app = NSRunningApplication(processIdentifier: target.ownerPid) else { throw refuse(profiler, .refusedOwnerMissing) }
  guard !app.isHidden else { throw refuse(profiler, .refusedOwnerHidden) }
  guard app.bundleIdentifier == target.appId else { throw refuse(profiler, .refusedOwnerBundle) }
  guard lifetime(app) == target.processIdentity else { throw refuse(profiler, .refusedLifetime) }
  profiler?.phase(after ? .afterShareable : .beforeShareable)
  let content: SCShareableContent
  do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
  catch { throw refuse(profiler, .refusedEnumeration) }
  profiler?.phase(after ? .afterValidate : .beforeValidate)
  let matches = content.windows.filter { String($0.windowID) == target.windowId }
  guard matches.count == 1, let window = matches.first else { throw refuse(profiler, .refusedWindowMatch) }
  guard window.isOnScreen else { throw refuse(profiler, .refusedOnScreen) }
  guard window.windowLayer == 0 else { throw refuse(profiler, .refusedLayer) }
  guard window.owningApplication?.processID == target.ownerPid else { throw refuse(profiler, .refusedWindowPID) }
  guard window.owningApplication?.bundleIdentifier == target.appId else { throw refuse(profiler, .refusedWindowBundle) }
  guard let title = window.title, hash(Data(title.utf8)) == target.titleHash else { throw refuse(profiler, .refusedTitle) }
  let filter = SCContentFilter(desktopIndependentWindow: window)
  let width = Int((window.frame.width * Double(filter.pointPixelScale)).rounded())
  let height = Int((window.frame.height * Double(filter.pointPixelScale)).rounded())
  guard TaskCapturePolicy.geometry(width: width, height: height, bounds: window.frame, display: CGDisplayBounds(target.displayId)) else { throw refuse(profiler, .refusedGeometry) }
  guard !content.displays.contains(where: { $0.displayID != target.displayId && CGDisplayBounds($0.displayID).intersects(window.frame) }) else { throw refuse(profiler, .refusedDisplayOverlap) }
  guard available() else { throw refuse(profiler, .refusedAvailability) }
  guard grant.permits(target, now: Date().timeIntervalSince1970 * 1000) else { throw refuse(profiler, .refusedGrant) }
  guard lifetime(app) == target.processIdentity else { throw refuse(profiler, .refusedLifetime) }
  return (window, window.frame, width, height)
}

private struct Request: Decodable { let id: String; let op: String; let target: TaskCaptureTarget? }

@main struct TaskCaptureMain {
  @MainActor static func main() async {
    // The fixed config contains metadata only. No listener, enumeration, TCC
    // prompt or capture occurs before a parent request. stdin EOF ends ownership.
    do {
      let args = CommandLine.arguments
      if args.count == 2, args[1] == "--preflight" {
        var result = try JSONSerialization.data(withJSONObject: preflight(), options: [.sortedKeys]); result.append(10)
        try FileHandle.standardOutput.write(contentsOf: result)
        return
      }
      if args.count == 3, args[1] == "--resolve-target" {
        let state = preflight()
        guard state["screenPermission"] == true else { throw ResolutionRefused(reason: "screen_permission_required") }
        guard state["onConsole"] == true, state["loginComplete"] == true, state["locked"] == false else { throw ResolutionRefused(reason: "unlocked_console_required") }
        let path = args[2]
        var file = stat()
        guard lstat(path, &file) == 0, (file.st_mode & S_IFMT) == S_IFREG,
          file.st_uid == getuid(), file.st_mode & 0o077 == 0, file.st_size > 0, file.st_size <= 4096,
          let query = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as? [String: String],
          Set(query.keys) == ["appId", "title"], let appId = query["appId"], let title = query["title"],
          !title.isEmpty, title.utf8.count <= 640 else { throw ResolutionRefused(reason: "private_query_invalid") }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
        catch { throw ResolutionRefused(reason: "window_metadata_unavailable") }
        let sameApp = content.windows.filter { $0.owningApplication?.bundleIdentifier == appId }
        let exactTitle = content.windows.filter { $0.title == title }
        let exactAppTitle = sameApp.filter { $0.title == title }
        let matches = exactAppTitle.filter { $0.windowLayer == 0 && $0.isOnScreen }
        guard matches.count == 1 else {
          throw ResolutionRefused(reason: matches.isEmpty ? "exact_window_not_found" : "exact_window_ambiguous",
            geometry: ["sameAppCount": min(sameApp.count, 1000000), "exactTitleCount": min(exactTitle.count, 1000000),
              "exactAppTitleCount": min(exactAppTitle.count, 1000000),
              "exactOnScreenCount": min(exactAppTitle.filter { $0.isOnScreen }.count, 1000000),
              "exactLayerZeroCount": min(exactAppTitle.filter { $0.windowLayer == 0 }.count, 1000000),
              "queryAppInstances": NSRunningApplication.runningApplications(withBundleIdentifier: appId).prefix(4).map {
                ["hidden": $0.isHidden, "active": $0.isActive, "terminated": $0.isTerminated] },
              "exactMatchedGeometry": exactAppTitle.prefix(4).map { windowWitness($0) }])
        }
        guard matches.count == 1, let window = matches.first, let owner = window.owningApplication,
          let app = NSRunningApplication(processIdentifier: owner.processID), let identity = lifetime(app) else { throw ResolutionRefused(reason: "process_identity_unavailable") }
        let displays = content.displays.filter { CGDisplayIsActive($0.displayID) != 0 && CGDisplayBounds($0.displayID).contains(window.frame) }
        guard displays.count == 1 else {
          let active = content.displays.filter { CGDisplayIsActive($0.displayID) != 0 }
          throw ResolutionRefused(reason: displays.isEmpty ? "window_outside_single_display" : "display_binding_ambiguous",
            geometry: ["windowBounds": rectangle(window.frame), "containingDisplayCount": displays.count,
              "activeDisplays": active.prefix(16).map { ["displayId": $0.displayID, "bounds": rectangle(CGDisplayBounds($0.displayID))] as [String: Any] }])
        }
        let target = TaskCaptureTarget(appId: appId, windowId: String(window.windowID), processIdentity: identity,
          titleHash: hash(Data(title.utf8)), ownerPid: owner.processID, displayId: displays[0].displayID)
        let grant = TaskCaptureGrant(presentationId: "metadata_resolution", expiresAt: Date().timeIntervalSince1970 * 1000 + 2000, targets: [target])
        do { _ = try await inspect(target, grant) }
        catch { throw ResolutionRefused(reason: "exact_target_changed_or_geometry_refused") }
        var result = try JSONEncoder().encode(target); result.append(10)
        try FileHandle.standardOutput.write(contentsOf: result)
        return
      }
      guard (args.count == 3 || (args.count == 4 && args[3] == "--profile-timing")), args[1] == "--config" else { throw failure() }
      let profiler = args.count == 4 ? CaptureProfiler() : nil
      let path = args[2]
      var file = stat()
      guard lstat(path, &file) == 0, (file.st_mode & S_IFMT) == S_IFREG,
        file.st_uid == getuid(), file.st_mode & 0o077 == 0, file.st_size > 0, file.st_size <= 16384 else { throw failure() }
      let grant = try JSONDecoder().decode(TaskCaptureGrant.self, from: Data(contentsOf: URL(fileURLWithPath: path)))
      let output = FileHandle.standardOutput
      // bytes.lines is incremental; no screen bytes are written to disk.
      for try await line in FileHandle.standardInput.bytes.lines {
        profiler?.phase(.inputReceived)
        guard line.utf8.count <= 8192, let data = line.data(using: .utf8) else { throw failure() }
        let request = try JSONDecoder().decode(Request.self, from: data)
        guard validID(request.id) else { throw failure() }
        if request.op == "stop" { break }
        do {
          guard ["inspect", "capture"].contains(request.op), let target = request.target else { throw failure() }
          let before = try await inspect(target, grant, profiler: profiler)
          var result: [String: Any] = ["id": request.id, "ok": true, "target": try JSONSerialization.jsonObject(with: JSONEncoder().encode(target)),
            "observedAt": Date().timeIntervalSince1970 * 1000, "width": before.2, "height": before.3]
          let bounds: [String: Double] = ["x": before.1.minX, "y": before.1.minY, "width": before.1.width, "height": before.1.height]
          result["bounds"] = bounds
          let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
          result["geometryGeneration"] = hash(try encoder.encode(bounds))
          var jpeg = Data()
          if request.op == "capture" {
            let capturedAt = Date().timeIntervalSince1970 * 1000
            let config = SCStreamConfiguration()
            config.width = before.2; config.height = before.3
            config.showsCursor = false; config.capturesAudio = false
            config.ignoreShadowsSingleWindow = true
            profiler?.phase(.captureImage)
            let image: CGImage
            do {
              image = try await SCScreenshotManager.captureImage(
                contentFilter: SCContentFilter(desktopIndependentWindow: before.0), configuration: config)
            } catch { throw refuse(profiler, .refusedCaptureImage) }
            let after = try await inspect(target, grant, profiler: profiler, after: true)
            guard before.1 == after.1, before.2 == after.2, before.3 == after.3 else { throw refuse(profiler, .refusedCaptureGeometry) }
            guard image.width == before.2, image.height == before.3 else { throw refuse(profiler, .refusedImageDimensions) }
            guard Date().timeIntervalSince1970 * 1000 - capturedAt < 1500 else { throw refuse(profiler, .refusedCaptureAge) }
            profiler?.phase(.jpegEncode)
            guard let encoded = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85]),
              encoded.count <= 2 * 1024 * 1024 else { throw refuse(profiler, .refusedEncoding) }
            jpeg = encoded
            result["capturedAt"] = capturedAt; result["sourceFrameId"] = UUID().uuidString
            result["contentRevision"] = hash(jpeg)
          }
          result["bytes"] = jpeg.count
          var header = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]); header.append(10)
          profiler?.phase(.responseWrite)
          try output.write(contentsOf: header)
          if !jpeg.isEmpty { try output.write(contentsOf: jpeg) }
          profiler?.phase(.idle)
        } catch {
          // Never expose target titles, OS exceptions, screen bytes or secrets.
          let response: [String: Any] = ["id": request.id, "ok": false, "reason": "exact_window_unavailable", "bytes": 0]
          var header = try JSONSerialization.data(withJSONObject: response); header.append(10)
          try output.write(contentsOf: header)
          profiler?.phase(.idle)
        }
      }
    } catch {
      if CommandLine.arguments.dropFirst().first == "--resolve-target" {
        let reason = (error as? ResolutionRefused)?.reason ?? "metadata_resolution_refused"
        var response: [String: Any] = ["ok": false, "reason": reason]
        if let geometry = (error as? ResolutionRefused)?.geometry { response["geometry"] = geometry }
        if var result = try? JSONSerialization.data(withJSONObject: response) {
          result.append(10); try? FileHandle.standardOutput.write(contentsOf: result)
        }
      }
      exit(2)
    }
  }
}
