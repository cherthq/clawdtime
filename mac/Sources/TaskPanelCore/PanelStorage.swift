import CryptoKit
import Darwin
import Foundation

public enum PrivatePanelFiles {
  static func directory(_ path: String) throws -> Int32 {
    let fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard fd >= 0 else { throw PanelFailure.privateStorage }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & 0o777 == 0o700 else {
      close(fd); throw PanelFailure.privateStorage
    }
    return fd
  }
  static func read(_ name: String, directory: Int32, maximum: Int) throws -> Data {
    let fd = openat(directory, name, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw PanelFailure.privateStorage }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
      info.st_mode & 0o777 == 0o600, info.st_size > 0, info.st_size <= maximum else { throw PanelFailure.privateStorage }
    let data = try handle.readToEnd() ?? Data()
    guard data.count <= maximum else { throw PanelFailure.privateStorage }
    return data
  }
  public static func configuration(at url: URL) throws -> PanelConfiguration {
    guard url.isFileURL, url.path.hasPrefix("/") else { throw PanelFailure.configuration }
    let directory = try directory(url.deletingLastPathComponent().path)
    defer { close(directory) }
    let data = try read(url.lastPathComponent, directory: directory, maximum: 16384)
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(object.keys) == Set(["version", "desktopId", "origin", "token", "projectRoot", "receiptDirectory", "configurationFingerprint"] + (object["boundTaskId"] == nil ? [] : ["boundTaskId"])) else { throw PanelFailure.configuration }
    let result = try JSONDecoder().decode(PanelConfiguration.self, from: data)
    try result.validate(configPath: url)
    return result
  }
  public static func digest(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}

/// Receipt metadata only: no task text, credentials or automatic effect replay.
public final class PanelReceiptStore {
  private let directory: Int32
  private let lock: Int32
  public private(set) var entries: [PendingPanelOperation] = []
  private let filename = "panel-operations.json"

  public init(directory path: String, binding: String? = nil) throws {
    directory = try PrivatePanelFiles.directory(path)
    lock = openat(directory, "panel.lock", O_RDWR | O_CREAT | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { close(directory); throw PanelFailure.privateStorage }
    var info = stat()
    guard fstat(lock, &info) == 0, info.st_uid == getuid(), info.st_mode & S_IFMT == S_IFREG,
      info.st_mode & 0o777 == 0o600 else { close(lock); close(directory); throw PanelFailure.privateStorage }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else {
      var raw = [UInt8](repeating: 0, count: 512)
      let count = Darwin.read(lock, &raw, raw.count)
      let matches = binding == nil || count > 0 && String(bytes: raw.prefix(count), encoding: .utf8) == binding
      close(lock); close(directory)
      throw matches ? PanelFailure.alreadyOpen : PanelFailure.differentPanel
    }
    if let binding {
      guard binding.count <= 400, ftruncate(lock, 0) == 0 else { close(lock); close(directory); throw PanelFailure.privateStorage }
      let raw = Data(binding.utf8)
      let written = raw.withUnsafeBytes { Darwin.write(lock, $0.baseAddress, $0.count) }
      guard written == raw.count, fsync(lock) == 0 else { close(lock); close(directory); throw PanelFailure.privateStorage }
    }
    do {
      var fileInfo = stat()
      if fstatat(directory, filename, &fileInfo, AT_SYMLINK_NOFOLLOW) == 0 {
        entries = try JSONDecoder().decode([PendingPanelOperation].self,
          from: PrivatePanelFiles.read(filename, directory: directory, maximum: 262144))
        guard entries.count <= 512, Set(entries.map(\.eventId)).count == entries.count,
          entries.allSatisfy({ PanelConfiguration.identity($0.eventId) &&
            $0.digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil &&
            ["pending", "done", "refused", "unknown"].contains($0.state) && $0.createdAt.isFinite }) else { throw PanelFailure.privateStorage }
        for index in entries.indices where entries[index].unresolved { entries[index].state = "unknown" }
      } else if errno != ENOENT { throw PanelFailure.privateStorage }
    } catch {
      close(lock); close(directory); throw PanelFailure.privateStorage
    }
  }
  deinit { close(lock); close(directory) }

  private func persist() throws {
    let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
    let data = try encoder.encode(entries)
    let temporary = ".panel-" + UUID().uuidString + ".tmp"
    let fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)
    guard fd >= 0 else { throw PanelFailure.privateStorage }
    defer { close(fd); unlinkat(directory, temporary, 0) }
    let result = data.withUnsafeBytes { buffer -> Bool in
      var offset = 0
      while offset < buffer.count {
        let count = Darwin.write(fd, buffer.baseAddress!.advanced(by: offset), buffer.count - offset)
        if count <= 0 { return false }; offset += count
      }
      return true
    }
    guard result, fsync(fd) == 0, renameat(directory, temporary, directory, filename) == 0,
      fsync(directory) == 0 else { throw PanelFailure.privateStorage }
  }
  public func reserve(action: PanelAction, eventId: String, payload: Data) throws {
    guard PanelConfiguration.identity(eventId), !entries.contains(where: { $0.eventId == eventId }),
      entries.filter(\.unresolved).count < 32 else { throw PanelFailure.unresolved }
    if entries.count >= 512 { entries.removeAll { !$0.unresolved } }
    entries.append(PendingPanelOperation(eventId: eventId, digest: PrivatePanelFiles.digest(payload), action: action,
      state: "pending", createdAt: Date().timeIntervalSince1970 * 1000))
    do { try persist() } catch {
      // Keep the in-memory tombstone too: no POST follows a failed persistence.
      entries[entries.count - 1].state = "unknown"
      throw PanelFailure.privateStorage
    }
  }
  public func observe(_ operation: PanelOperation) throws {
    try operation.validate()
    guard let index = entries.firstIndex(where: { $0.eventId == operation.eventId }) else { return }
    guard operation.action == nil && operation.state == "not_found" || operation.action == entries[index].action else { throw PanelFailure.response }
    if !entries[index].unresolved { return } // A terminal receipt never regresses.
    let next = operation.state == "not_found" ? "unknown" : operation.state
    if entries[index].state == next { return }
    entries[index].state = next
    try persist()
  }
  public func markUnknown(_ eventId: String) throws {
    guard let index = entries.firstIndex(where: { $0.eventId == eventId }), entries[index].unresolved else { return }
    entries[index].state = "unknown"
    try persist()
  }
}
