import Foundation

/// Plain-text evidence only. No HTML, URLs to navigate, scripts, commands or capture authority.
public struct PreparedReviewDocument: Codable, Sendable {
    public struct Section: Codable, Sendable { public let heading: String; public let text: String }
    public let version: Int
    public let title: String
    public let sections: [Section]
    public let expiresAt: Double

    public static func parse(_ data: Data, now: Double = Date().timeIntervalSince1970 * 1000) throws -> PreparedReviewDocument {
        guard data.count <= 32768,
              let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(raw.keys) == ["version", "title", "sections", "expiresAt"],
              let sections = raw["sections"] as? [[String: Any]],
              sections.allSatisfy({ Set($0.keys) == ["heading", "text"] }) else { throw ReviewError.invalid }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.version == 1, value.title.hasPrefix("ClawdTime review "),
              value.title.count <= 160, !value.title.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }),
              !value.sections.isEmpty, value.sections.count <= 12,
              value.sections.allSatisfy({ !$0.heading.isEmpty && $0.heading.count <= 160 && $0.text.count <= 8000 }),
              value.sections.reduce(0, { $0 + $1.heading.count + $1.text.count }) <= 16000,
              value.expiresAt.isFinite, value.expiresAt > now, value.expiresAt <= now + 1_800_000 else { throw ReviewError.invalid }
        return value
    }
    public enum ReviewError: Error { case invalid }
}

public struct PreparedReviewCommand: Sendable {
    public let id: String
    public static func parse(_ data: Data) throws -> Self {
        guard data.count <= 1024,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              Set(value.keys) == ["id", "op"], value["op"] as? String == "invalidate",
              let id = value["id"] as? String,
              id.range(of: "^[A-Za-z0-9_-]{1,120}$", options: .regularExpression) != nil else { throw PreparedReviewDocument.ReviewError.invalid }
        return Self(id: id)
    }
}
