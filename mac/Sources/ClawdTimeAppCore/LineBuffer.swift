import Foundation

/// Splits a byte stream into lines. A line longer than the limit is dropped
/// whole and counted, so one runaway line cannot grow memory without bound.
public struct LineBuffer: Sendable {
  public let limit: Int
  private var pending = Data()
  private var discarding = false
  public private(set) var droppedLines = 0

  public init(limit: Int = 1 << 20) { self.limit = limit }

  /// Adds bytes and returns every line they complete, without the newline.
  public mutating func append(_ data: Data) -> [String] {
    var lines: [String] = []
    var start = data.startIndex
    while let newline = data[start...].firstIndex(of: 0x0A) {
      let chunk = data[start..<newline]
      if discarding {
        discarding = false
      } else if pending.count + chunk.count > limit {
        droppedLines += 1
      } else {
        pending.append(chunk)
        lines.append(Self.text(pending))
      }
      pending.removeAll(keepingCapacity: true)
      start = data.index(after: newline)
    }
    let rest = data[start...]
    if !discarding {
      if pending.count + rest.count > limit {
        pending.removeAll()
        discarding = true
        droppedLines += 1
      } else {
        pending.append(rest)
      }
    }
    return lines
  }

  /// The last line when the stream ends without a newline.
  public mutating func finish() -> String? {
    defer { pending.removeAll(); discarding = false }
    guard !discarding, !pending.isEmpty else { return nil }
    return Self.text(pending)
  }

  private static func text(_ data: Data) -> String {
    var line = String(decoding: data, as: UTF8.self)
    if line.hasSuffix("\r") { line.removeLast() }
    return line
  }
}

/// The last few lines of a stream, for a failure view.
public struct TailBuffer: Sendable {
  public let capacity: Int
  public private(set) var lines: [String] = []
  public init(capacity: Int = 12) { self.capacity = capacity }
  public mutating func append(_ line: String) {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return }
    lines.append(String(trimmed.prefix(400)))
    if lines.count > capacity { lines.removeFirst(lines.count - capacity) }
  }
}
