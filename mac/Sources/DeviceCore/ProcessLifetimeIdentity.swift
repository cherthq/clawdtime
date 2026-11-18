import Foundation

/// Source-tagged process start witness; never substitutes an observation time or PID alone.
public struct ProcessLifetimeIdentity: Equatable {
  public let pid: Int32
  public let bundleId: String
  public let source: String
  private let start: String
  public var stableMaterial: String { "\(pid)|\(bundleId)|\(source)|\(start)" }

  public static func resolve(pid: Int32, bundleId: String, launchTime: Double?,
      kernelPID: Int32? = nil, kernelSeconds: Int64? = nil, kernelMicroseconds: Int64? = nil) -> Self? {
    guard pid > 0, !bundleId.isEmpty else { return nil }
    if let launchTime {
      guard launchTime.isFinite, launchTime > 0 else { return nil }
      return Self(pid: pid, bundleId: bundleId, source: "launch_date", start: String(launchTime.bitPattern, radix: 16))
    }
    guard kernelPID == pid, let seconds = kernelSeconds, let microseconds = kernelMicroseconds,
      seconds > 0, (0..<1_000_000).contains(microseconds) else { return nil }
    return Self(pid: pid, bundleId: bundleId, source: "kernel_start", start: "\(seconds):\(microseconds)")
  }
}
