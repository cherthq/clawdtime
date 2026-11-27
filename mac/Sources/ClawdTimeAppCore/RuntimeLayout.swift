import CryptoKit
import Foundation

/// `runtime/manifest.json`, written by the runtime builder.
public struct RuntimeManifest: Decodable, Equatable, Sendable {
  public var name: String
  public var version: String
  public var commit: String
  public var arch: String
  public var node: String?
  /// Each path is relative to the runtime folder; each value is a lowercase SHA-256.
  public var files: [String: String]
}

public enum RuntimeProblem: Error, Equatable, CustomStringConvertible, Sendable {
  case missing(String)
  case notExecutable(String)
  case badManifest(String)
  case unsafePath(String)
  case hashMismatch(String)

  public var description: String {
    switch self {
    case .missing(let path): "The runtime has no \(path)."
    case .notExecutable(let path): "\(path) in the runtime cannot run."
    case .badManifest(let reason): "The runtime manifest is not valid: \(reason)."
    case .unsafePath(let path): "The runtime manifest names a path outside the runtime: \(path)."
    case .hashMismatch(let path): "\(path) in the runtime differs from its manifest."
    }
  }
}

/// The runtime bundled at `ClawdTime.app/Contents/Resources/runtime`.
public struct RuntimeLayout: Equatable, Sendable {
  public static let folderName = "runtime"
  public let root: URL
  public let manifest: RuntimeManifest

  public var launcher: URL { root.appendingPathComponent("bin/clawdtime") }
  public var node: URL { root.appendingPathComponent("node/bin/node") }

  /// The runtime inside an app bundle.
  public static func bundled(in bundle: Bundle = .main) -> URL? {
    bundle.resourceURL?.appendingPathComponent(folderName, isDirectory: true)
  }

  /// Checks the layout and reads the manifest. It does not hash the files: `verify()` does.
  public static func load(_ root: URL) throws -> RuntimeLayout {
    let files = FileManager.default
    let root = root.standardizedFileURL
    var isFolder: ObjCBool = false
    guard files.fileExists(atPath: root.path, isDirectory: &isFolder), isFolder.boolValue else {
      throw RuntimeProblem.missing("runtime folder")
    }
    for executable in ["bin/clawdtime", "node/bin/node"] {
      let path = root.appendingPathComponent(executable).path
      guard files.fileExists(atPath: path) else { throw RuntimeProblem.missing(executable) }
      guard files.isExecutableFile(atPath: path) else { throw RuntimeProblem.notExecutable(executable) }
    }
    for required in ["app/package.json", "app/release.json", "manifest.json"] {
      guard files.fileExists(atPath: root.appendingPathComponent(required).path) else { throw RuntimeProblem.missing(required) }
    }
    let manifest: RuntimeManifest
    do {
      manifest = try JSONDecoder().decode(RuntimeManifest.self, from: Data(contentsOf: root.appendingPathComponent("manifest.json")))
    } catch {
      throw RuntimeProblem.badManifest("it cannot be read")
    }
    guard manifest.name == "clawdtime" else { throw RuntimeProblem.badManifest("name is \(manifest.name)") }
    guard manifest.arch == "arm64" else { throw RuntimeProblem.badManifest("arch is \(manifest.arch)") }
    guard Self.isReleaseVersion(manifest.version) else { throw RuntimeProblem.badManifest("version is \(manifest.version)") }
    guard !manifest.files.isEmpty else { throw RuntimeProblem.badManifest("it lists no files") }
    for (path, hash) in manifest.files {
      try Self.checkRelative(path)
      guard hash.count == 64, hash.allSatisfy({ "0123456789abcdef".contains($0) }) else {
        throw RuntimeProblem.badManifest("the hash of \(path) is not a lowercase SHA-256")
      }
    }
    return RuntimeLayout(root: root, manifest: manifest)
  }

  /// Three numbers, as an app version needs: each with no leading zero and at
  /// most four digits, the rule of the runtime builder and package-app.sh.
  public static func isReleaseVersion(_ version: String) -> Bool {
    let parts = version.split(separator: ".", omittingEmptySubsequences: false)
    return parts.count == 3 && parts.allSatisfy { part in
      !part.isEmpty && part.count <= 4 && part.allSatisfy { ("0"..."9").contains($0) } && (part == "0" || part.first != "0")
    }
  }

  static func checkRelative(_ path: String) throws {
    let parts = path.split(separator: "/", omittingEmptySubsequences: false)
    guard !path.isEmpty, !path.hasPrefix("/"), !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
      throw RuntimeProblem.unsafePath(path)
    }
  }

  public struct Verification: Equatable, Sendable {
    /// Files whose bytes match the manifest.
    public var hashed: Int
    /// Mach-O files. Signing for the app embeds a signature in each, so their
    /// bytes differ from the unsigned runtime; their code signature stands in for the hash.
    public var signed: Int
  }

  /// Checks every file the manifest lists, and returns how many it checked.
  @discardableResult
  public func verify() throws -> Int {
    let result = try verification()
    return result.hashed + result.signed
  }

  public func verification() throws -> Verification {
    let base = root.resolvingSymlinksInPath().path + "/"
    var result = Verification(hashed: 0, signed: 0)
    for (path, expected) in manifest.files.sorted(by: { $0.key < $1.key }) {
      let file = root.appendingPathComponent(path)
      guard file.resolvingSymlinksInPath().path.hasPrefix(base) else { throw RuntimeProblem.unsafePath(path) }
      guard let digest = Self.sha256(of: file) else { throw RuntimeProblem.missing(path) }
      if digest == expected {
        result.hashed += 1
      } else if Self.isMachO(file) {
        result.signed += 1
      } else {
        throw RuntimeProblem.hashMismatch(path)
      }
    }
    return result
  }

  /// A thin or universal Mach-O file, by its first bytes.
  static func isMachO(_ file: URL) -> Bool {
    guard let handle = try? FileHandle(forReadingFrom: file) else { return false }
    defer { try? handle.close() }
    guard let head = try? handle.read(upToCount: 8), head.count == 8 else { return false }
    let bytes = [UInt8](head)
    let magic = UInt32(bytes[0]) << 24 | UInt32(bytes[1]) << 16 | UInt32(bytes[2]) << 8 | UInt32(bytes[3])
    let count = UInt32(bytes[4]) << 24 | UInt32(bytes[5]) << 16 | UInt32(bytes[6]) << 8 | UInt32(bytes[7])
    if [0xFEEDFACF, 0xCFFAEDFE, 0xFEEDFACE, 0xCEFAEDFE].contains(magic) { return true }
    // A universal binary; a Java class file shares the magic but not the small count.
    return (magic == 0xCAFEBABE || magic == 0xCAFEBABF) && count > 0 && count < 30
  }

  static func sha256(of file: URL) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: file) else { return nil }
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
      let chunk: Data?
      do { chunk = try handle.read(upToCount: 1 << 20) } catch { return nil }
      // nil or empty: the end of the file.
      guard let chunk, !chunk.isEmpty else { break }
      hasher.update(data: chunk)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
  }
}
