import Darwin
import Foundation

/// Normal Finder/TCC relaunches omit command-line arguments. Only the independent
/// ClawdTime setup path is a default; missing/unsafe configuration never falls back
/// to another app, device, display, or permission grant.
public func configurationURL(arguments: [String], applicationSupport: URL, localOnly: Bool = false) throws -> URL {
  if let index = arguments.firstIndex(of: "--config") {
    guard arguments.count > index + 1, arguments[index + 1].hasPrefix("/") else {
      throw HelperError(400, "--config requires an absolute private configuration path.")
    }
    return URL(fileURLWithPath: arguments[index + 1]).standardizedFileURL
  }
  return applicationSupport.appendingPathComponent(localOnly ? "ClawdTimeLocalControl" : "ClawdTimeCompanion", isDirectory: true)
    .appendingPathComponent("setup", isDirectory: true).appendingPathComponent("helper.json")
}

/// Open and validate the same descriptors that are read, so a symlink replacement
/// cannot change the file after its ownership check. Loading never arms DevicePolicy.
public func loadConfiguration(arguments: [String], applicationSupport: URL, localOnly: Bool = false) throws -> HelperConfig {
  let url = try configurationURL(arguments: arguments, applicationSupport: applicationSupport, localOnly: localOnly)
  let directory = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
  guard directory >= 0 else {
    throw HelperError(403, "Private ClawdTime setup directory is unavailable. Complete local setup first.")
  }
  defer { close(directory) }
  var directoryInfo = stat()
  guard fstat(directory, &directoryInfo) == 0, directoryInfo.st_uid == getuid(),
    directoryInfo.st_mode & 0o777 == 0o700
  else {
    throw HelperError(403, "Configuration directory must be owner-only with mode 0700.")
  }
  let file = openat(directory, url.lastPathComponent, O_RDONLY | O_NOFOLLOW)
  guard file >= 0 else {
    throw HelperError(403, "Private ClawdTime configuration is unavailable. Complete local setup first.")
  }
  let handle = FileHandle(fileDescriptor: file, closeOnDealloc: true)
  var fileInfo = stat()
  guard fstat(file, &fileInfo) == 0, fileInfo.st_mode & S_IFMT == S_IFREG,
    fileInfo.st_uid == getuid(), fileInfo.st_mode & 0o777 == 0o600,
    fileInfo.st_size > 0, fileInfo.st_size <= 65536
  else {
    throw HelperError(403, "Configuration must be an owner-only regular file with mode 0600.")
  }
  let data = try handle.readToEnd() ?? Data()
  guard data.count <= 65536 else { throw HelperError(413, "Configuration exceeds its size limit.") }
  let config = try JSONDecoder().decode(HelperConfig.self, from: data)
  try config.validate()
  try validateLocalOnlyConfiguration(config, localOnly: localOnly)
  return config
}

/// The standalone bundle cannot inherit remote-call displays or tailnet access.
public func validateLocalOnlyConfiguration(_ config: HelperConfig, localOnly: Bool) throws {
  guard !localOnly || (config.bind == "127.0.0.1" && config.displays.isEmpty) else {
    throw HelperError(403, "ClawdTime Local Control requires loopback and an empty call-display list.")
  }
}
