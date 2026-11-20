import Foundation
import Darwin

/// Source-tagged process start witness; never substitutes an observation time or PID alone.
public struct ProcessLifetimeIdentity: Equatable {
  public let pid: Int32
  public let bundleId: String
  public let source: String
  private let start: String
  public var stableMaterial: String { "\(pid)|\(bundleId)|\(source)|\(start)" }

  /// Directly spawned AppKit programs may have no Launch Services date. The
  /// kernel start tuple remains an actual process-lifetime witness, never a clock
  /// observation or PID-only identity. Short/error reads fail closed.
  public static func resolveLive(pid: Int32, bundleId: String, launchTime: Double?) -> Self? {
    if launchTime != nil { return resolve(pid: pid, bundleId: bundleId, launchTime: launchTime) }
    guard pid > 0 else { return nil }
    var info = proc_bsdinfo()
    let size = MemoryLayout<proc_bsdinfo>.size
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(size)) == Int32(size),
      info.pbi_pid == UInt32(pid), info.pbi_start_tvsec <= UInt64(Int64.max),
      info.pbi_start_tvusec <= UInt64(Int64.max) else { return nil }
    return resolve(pid: pid, bundleId: bundleId, launchTime: nil, kernelPID: Int32(info.pbi_pid),
      kernelSeconds: Int64(info.pbi_start_tvsec), kernelMicroseconds: Int64(info.pbi_start_tvusec))
  }

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
