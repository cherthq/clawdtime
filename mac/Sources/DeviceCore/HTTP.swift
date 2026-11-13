import Foundation

/// Preserve capture-start precision on the wire. Flooring to milliseconds never
/// makes a capture appear newer; whole-second formatting can add almost one
/// second to its apparent age and wrongly fail the two-second freshness check.
public func frameCaptureTimestamp(_ capturedAt: Date) -> String {
  let milliseconds = floor(capturedAt.timeIntervalSince1970 * 1000)
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter.string(from: Date(timeIntervalSince1970: milliseconds / 1000))
}

public struct HTTPRequest {
  public var method: String
  public var path: String
  public var headers: [String: String]
  public var body: Data
  public static func parse(_ data: Data) throws -> HTTPRequest? {
    guard data.count <= 73732 else { throw HelperError(413, "Request too large.") }
    guard let range = data.range(of: Data("\r\n\r\n".utf8)) else {
      if data.count > 8192 { throw HelperError(413, "Headers too large.") }
      return nil
    }
    guard range.lowerBound <= 8192,
      let header = String(data: data[..<range.lowerBound], encoding: .utf8)
    else { throw HelperError(400, "Invalid headers.") }
    let lines = header.components(separatedBy: "\r\n")
    let start = lines[0].split(separator: " ")
    guard start.count == 3, start[2] == "HTTP/1.1",
      ["GET", "POST", "DELETE"].contains(String(start[0])), start[1].hasPrefix("/v1/"),
      !start[1].contains("?"), !start[1].contains("%")
    else { throw HelperError(400, "Invalid request line.") }
    var headers = [String: String]()
    for line in lines.dropFirst() {
      guard let colon = line.firstIndex(of: ":") else {
        throw HelperError(400, "Malformed header.")
      }
      let key = String(line[..<colon]).lowercased()
      let value = String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
      guard !key.isEmpty, headers[key] == nil, !key.contains(" ") else {
        throw HelperError(400, "Duplicate or invalid header.")
      }
      headers[key] = value
    }
    guard headers["transfer-encoding"] == nil else {
      throw HelperError(400, "Transfer encoding is unsupported.")
    }
    let rawLength = headers["content-length"] ?? "0"
    let bodyLimit = start[0] == "POST" && start[1] == "/v1/panel" ? 65536 : 16384
    guard rawLength.allSatisfy(\.isNumber), let count = Int(rawLength), count >= 0, count <= bodyLimit
    else { throw HelperError(413, "Invalid content length.") }
    let body = data[range.upperBound...]
    if body.count < count { return nil }
    guard body.count == count else { throw HelperError(400, "Pipelining is unsupported.") }
    return HTTPRequest(
      method: String(start[0]), path: String(start[1]), headers: headers, body: Data(body))
  }
}
