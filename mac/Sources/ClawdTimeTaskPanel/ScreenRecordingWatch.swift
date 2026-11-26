import Darwin
import Foundation
import TaskPanelCore

/// Whether macOS records the screen now, for the pace of the guided cursor. It reads the short names of the
/// processes and nothing else of them, at most once a second. About 500 names take a third of a millisecond
/// on a laptop (measured 26 Nov 2026). `ScreenRecordingSign` holds the rule.
@MainActor final class ScreenRecordingWatch {
  private var readAt: Date?
  private var last = false

  /// True while a recorder of macOS runs. The answer of the last second is kept.
  var recording: Bool {
    if let readAt, Date().timeIntervalSince(readAt) < 1 { return last }
    readAt = Date()
    last = ScreenRecordingSign.recording(processes: Self.names())
    return last
  }

  /// The short names of the processes of this Mac that this user may see.
  static func names() -> [String] {
    let room = proc_listallpids(nil, 0)
    guard room > 0 else { return [] }
    // A few more places than there are processes now: one can start in between.
    var pids = [pid_t](repeating: 0, count: Int(room) + 64)
    let count = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
    guard count > 0 else { return [] }
    var names: [String] = []
    names.reserveCapacity(Int(count))
    var buffer = [CChar](repeating: 0, count: 2 * Int(MAXCOMLEN) + 1)
    for pid in pids.prefix(min(Int(count), pids.count)) where pid > 0 {
      guard proc_name(pid, &buffer, UInt32(buffer.count)) > 0 else { continue }
      names.append(buffer.withUnsafeBufferPointer { String(cString: $0.baseAddress!) })
    }
    return names
  }
}
