import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import DeviceCore
import ScreenCaptureKit

private func displayFailure() -> NSError { NSError(domain: "selected_display_unavailable", code: 1) }
private func displayHash(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
private func displayJSON(_ value: Any) throws {
  var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]); bytes.append(10)
  try FileHandle.standardOutput.write(contentsOf: bytes)
}
private func displayObject<T: Encodable>(_ value: T) throws -> Any {
  try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
}
/// CoreGraphics metadata only: no SCK enumeration, TCC prompt, screen image or input.
private func displayTarget(_ id: UInt32) throws -> TaskDisplayCaptureTarget {
  guard id > 0, CGDisplayIsActive(id) != 0, CGDisplayIsInMirrorSet(id) == 0,
    let uuid = CGDisplayCreateUUIDFromDisplayID(id)?.takeRetainedValue() else { throw displayFailure() }
  let bounds = CGDisplayBounds(id)
  let target = TaskDisplayCaptureTarget(displayId: id,
    displayUUID: CFUUIDCreateString(nil, uuid) as String,
    x: bounds.minX, y: bounds.minY, width: bounds.width, height: bounds.height)
  guard target.validate() else { throw displayFailure() }
  return target
}
@MainActor private func displayAvailable() -> Bool {
  guard CGPreflightScreenCaptureAccess(), let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
  return session[kCGSessionOnConsoleKey as String] as? Bool == true
    && session[kCGSessionLoginDoneKey as String] as? Bool == true
    && session["CGSSessionScreenIsLocked"] as? Bool != true
}
@MainActor private func inspectDisplay(_ target: TaskDisplayCaptureTarget, grant: TaskDisplayCaptureGrant) async throws -> SCDisplay {
  guard displayAvailable(), grant.permits(target, now: Date().timeIntervalSince1970 * 1000),
    try displayTarget(target.displayId) == target else { throw displayFailure() }
  let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
  guard let display = content.displays.first(where: { $0.displayID == target.displayId }),
    displayAvailable(), grant.permits(target, now: Date().timeIntervalSince1970 * 1000),
    try displayTarget(target.displayId) == target else { throw displayFailure() }
  return display
}
private struct DisplayRequest: Decodable {
  let id: String
  let op: String
  let target: TaskDisplayCaptureTarget?
}

/// A separate opt-in argument prevents a legacy window grant from selecting a display.
/// stdin EOF/Stop terminates this process owner; the parent joins it before releasing ownership.
@MainActor func handleDisplayCaptureArguments(_ args: [String]) async throws -> Bool {
  guard args.count > 1, ["--list-displays", "--resolve-display", "--display-config"].contains(args[1]) else { return false }
  if args[1] == "--list-displays" {
    guard args.count == 2 else { throw displayFailure() }
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count <= 32 else { throw displayFailure() }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    guard CGGetActiveDisplayList(count, &ids, &count) == .success else { throw displayFailure() }
    let displays = try ids.prefix(Int(count)).map { id -> [String: Any] in
      var value = try displayObject(displayTarget(id)) as! [String: Any]
      value["isMain"] = id == CGMainDisplayID(); return value
    }
    try displayJSON(displays); return true
  }
  guard args.count == 3 else { throw displayFailure() }
  if args[1] == "--resolve-display" {
    guard let id = UInt32(args[2]) else { throw displayFailure() }
    try displayJSON(displayObject(displayTarget(id))); return true
  }
  let path = args[2]
  let descriptor = open(path, O_RDONLY | O_NOFOLLOW)
  guard descriptor >= 0 else { throw displayFailure() }
  let file = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
  var info = stat()
  guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
    info.st_uid == getuid(), info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 16384,
    let data = try file.read(upToCount: 16385), data.count <= 16384 else { throw displayFailure() }
  let grant = try JSONDecoder().decode(TaskDisplayCaptureGrant.self, from: data)
  try file.close()
  for try await line in FileHandle.standardInput.bytes.lines {
    guard line.utf8.count <= 8192, let input = line.data(using: .utf8) else { throw displayFailure() }
    let request = try JSONDecoder().decode(DisplayRequest.self, from: input)
    guard validID(request.id) else { throw displayFailure() }
    if request.op == "stop" { break }
    do {
      guard ["inspect", "capture"].contains(request.op), let target = request.target,
        let size = target.outputSize else { throw displayFailure() }
      let display = try await inspectDisplay(target, grant: grant)
      var result: [String: Any] = ["id": request.id, "ok": true, "target": try displayObject(target),
        "observedAt": Date().timeIntervalSince1970 * 1000, "width": size.width, "height": size.height]
      var jpeg = Data()
      if request.op == "capture" {
        let config = SCStreamConfiguration()
        config.width = size.width; config.height = size.height
        config.showsCursor = true; config.capturesAudio = false
        // Includes the actual desktop and windows on exactly this display. Never a prepared answer window filter.
        // A screenshot also works when the selected display is static. A new
        // stream can emit only idle frames and never satisfy a fresh-frame wait.
        // Timestamp the start conservatively; the age check includes acquisition.
        let capturedAt = Date().timeIntervalSince1970 * 1000
        let image = try await SCScreenshotManager.captureImage(
          contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: config)
        _ = try await inspectDisplay(target, grant: grant)
        guard image.width == size.width, image.height == size.height,
          let encoded = NSBitmapImageRep(cgImage: image).representation(using: .jpeg, properties: [.compressionFactor: 0.85]),
          encoded.count <= 2 * 1024 * 1024 else { throw displayFailure() }
        let age = Date().timeIntervalSince1970 * 1000 - capturedAt
        guard age >= 0, age < 1000, displayAvailable(),
          grant.permits(target, now: Date().timeIntervalSince1970 * 1000),
          try displayTarget(target.displayId) == target else { throw displayFailure() }
        jpeg = encoded
        result["capturedAt"] = capturedAt; result["sourceFrameId"] = UUID().uuidString
        result["contentRevision"] = displayHash(jpeg)
      }
      result["bytes"] = jpeg.count
      try displayJSON(result)
      if !jpeg.isEmpty { try FileHandle.standardOutput.write(contentsOf: jpeg) }
    } catch {
      try displayJSON(["id": request.id, "ok": false, "reason": "selected_display_unavailable", "bytes": 0])
    }
  }
  return true
}
