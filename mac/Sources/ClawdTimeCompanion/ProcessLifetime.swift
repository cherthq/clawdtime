import AppKit
import Darwin
import DeviceCore

/// Apple documents KERN_PROC_PID returning kinfo_proc via sysctl(3). The public
/// SDK exports extern_proc.p_starttime as p_un.__p_starttime. Read one exact PID,
/// never the process table; discard all other returned fields immediately.
@MainActor func processLifetime(_ app: NSRunningApplication) -> ProcessLifetimeIdentity? {
  guard !app.isTerminated, let bundle = app.bundleIdentifier else { return nil }
  let pid = app.processIdentifier
  let launch = app.launchDate?.timeIntervalSince1970
  if let launch { return ProcessLifetimeIdentity.resolve(pid: pid, bundleId: bundle, launchTime: launch) }
  guard pid > 0 else { return nil }
  var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
  var info = kinfo_proc()
  var size = MemoryLayout<kinfo_proc>.size
  guard sysctl(&mib, UInt32(mib.count), &info, &size, nil, 0) == 0,
    size == MemoryLayout<kinfo_proc>.size, info.kp_proc.p_pid == pid else { return nil }
  let start = info.kp_proc.p_un.__p_starttime
  return ProcessLifetimeIdentity.resolve(pid: pid, bundleId: bundle, launchTime: nil,
    kernelPID: info.kp_proc.p_pid, kernelSeconds: Int64(start.tv_sec), kernelMicroseconds: Int64(start.tv_usec))
}
