import Darwin
import Foundation

/// A local preference is never permission to call, capture, or send input.
public enum ComputerControlPolicy: String, Codable, CaseIterable {
  case viewOnly = "view_only"
  case agentToolsOnly = "agent_tools_only"
  case agentToolsWithFallback = "agent_tools_with_fallback"

  public var label: String {
    switch self {
    case .viewOnly: return "View only"
    case .agentToolsOnly: return "Agent tools only"
    case .agentToolsWithFallback: return "Agent tools with ClawdTime fallback"
    }
  }
}

public struct ControlPreferences: Codable, Equatable {
  public var deviceId: String
  public var revision: Int
  public var policy: ComputerControlPolicy
  public init(deviceId: String, revision: Int = 1, policy: ComputerControlPolicy = .agentToolsOnly) {
    self.deviceId = deviceId
    self.revision = revision
    self.policy = policy
  }
}

/// Owner-only, fsynced local authority. No remote setter is exposed.
public final class ControlPreferenceStore {
  public private(set) var value: ControlPreferences
  private let directory: Int32
  private let name: String
  public init(url: URL, deviceId: String) throws {
    guard validID(deviceId) else { throw HelperError(400, "Invalid preference device.") }
    let folder = url.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true,
                                           attributes: [.posixPermissions: 0o700])
    let descriptor = open(folder.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard descriptor >= 0 else { throw HelperError(403, "Private policy directory unavailable.") }
    var info = stat()
    guard fstat(descriptor, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
      close(descriptor)
      throw HelperError(403, "Policy directory must be owner-only with mode 0700.")
    }
    directory = descriptor
    name = url.lastPathComponent
    value = ControlPreferences(deviceId: deviceId)
    let file = openat(directory, name, O_RDONLY | O_NOFOLLOW)
    if file >= 0 {
      defer { close(file) }
      var info = stat()
      guard fstat(file, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
        info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= 4096
      else { throw HelperError(403, "Policy must be a private regular file.") }
      let handle = FileHandle(fileDescriptor: file, closeOnDealloc: false)
      let data = try handle.readToEnd() ?? Data()
      guard data.count <= 4096 else { throw HelperError(400, "Policy exceeds its size limit.") }
      value = try JSONDecoder().decode(ControlPreferences.self, from: data)
      guard value.deviceId == deviceId, value.revision > 0 else {
        throw HelperError(403, "Policy belongs to another device or revision.")
      }
    } else {
      guard errno == ENOENT else { throw HelperError(403, "Policy file is unsafe or unavailable.") }
      try persist(value)
    }
  }
  deinit { close(directory) }
  private func persist(_ next: ControlPreferences) throws {
    let temporary = ".policy-" + UUID().uuidString
    let file = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard file >= 0 else { throw HelperError(503, "Cannot save local policy.") }
    defer { close(file); unlinkat(directory, temporary, 0) }
    let data = try JSONEncoder().encode(next)
    try data.withUnsafeBytes { raw in
      var offset = 0
      while offset < data.count {
        let count = write(file, raw.baseAddress!.advanced(by: offset), data.count - offset)
        guard count > 0 else { throw HelperError(503, "Cannot persist local policy.") }
        offset += count
      }
    }
    guard fsync(file) == 0, renameat(directory, temporary, directory, name) == 0,
      fsync(directory) == 0 else { throw HelperError(503, "Cannot commit local policy.") }
  }
  @discardableResult public func set(_ policy: ComputerControlPolicy) throws -> ControlPreferences {
    if policy == value.policy { return value }
    guard value.revision < Int.max else { throw HelperError(409, "Policy revision exhausted.") }
    let next = ControlPreferences(deviceId: value.deviceId, revision: value.revision + 1, policy: policy)
    try persist(next)
    value = next
    return value
  }
}
