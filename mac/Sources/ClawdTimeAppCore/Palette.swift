import Foundation

public struct BrandRGB: Equatable, Sendable {
  public let red: Double, green: Double, blue: Double
  public let hex: UInt32
  public init(_ hex: UInt32) {
    self.hex = hex
    red = Double((hex >> 16) & 0xFF) / 255
    green = Double((hex >> 8) & 0xFF) / 255
    blue = Double(hex & 0xFF) / 255
  }
  /// Relative luminance, as WCAG 2 defines it.
  public var luminance: Double {
    func linear(_ value: Double) -> Double { value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  }
  public static func contrast(_ a: BrandRGB, _ b: BrandRGB) -> Double {
    let high = max(a.luminance, b.luminance), low = min(a.luminance, b.luminance)
    return (high + 0.05) / (low + 0.05)
  }
}

/// The four brand colors, and the app's colors in light and dark mode.
public enum Brand {
  public static let paper = BrandRGB(0xF4F1E8)
  public static let ink = BrandRGB(0x252C27)
  public static let green = BrandRGB(0x366A43)
  public static let mint = BrandRGB(0xC8E6BB)

  public enum Token: CaseIterable, Sendable {
    case background, surface, text, secondaryText, primary, onPrimary, tint, onTint, line, danger, onDanger
  }

  public static func value(_ token: Token, dark: Bool) -> BrandRGB {
    switch (token, dark) {
    case (.background, false): paper
    case (.background, true): BrandRGB(0x1B201C)
    case (.surface, false): BrandRGB(0xFBF9F3)
    case (.surface, true): BrandRGB(0x242A25)
    case (.text, false): ink
    case (.text, true): paper
    case (.secondaryText, false): BrandRGB(0x59615B)
    case (.secondaryText, true): BrandRGB(0xB9C2BA)
    case (.primary, false): green
    case (.primary, true): mint
    case (.onPrimary, false): paper
    case (.onPrimary, true): ink
    case (.tint, false): mint
    case (.tint, true): BrandRGB(0x2F4A35)
    case (.onTint, false): ink
    case (.onTint, true): mint
    case (.line, false): BrandRGB(0xE2DDCF)
    case (.line, true): BrandRGB(0x353C36)
    case (.danger, false): BrandRGB(0xA8322A)
    case (.danger, true): BrandRGB(0xF08A80)
    case (.onDanger, false): paper
    case (.onDanger, true): BrandRGB(0x1B201C)
    }
  }
}
