import Foundation

/// The color tokens of the Chert design system, in its two themes: cream and charcoal.
/// They live here as plain numbers so that tests can check every text pair for contrast.
public enum ColorToken: String, CaseIterable, Sendable {
  case canvas, surface, raised, fill, fillPressed, borderSubtle, rule, borderStrong
  case label, labelSecondary, primary, onPrimary
  case accent, onAccent, accentText, accentTint
  case success, successTint, warning, warningTint, danger, dangerTint, info, infoTint
}

public struct RGB: Equatable, Sendable {
  public let red: Double, green: Double, blue: Double
  public init(_ hex: UInt32) {
    red = Double((hex >> 16) & 0xFF) / 255; green = Double((hex >> 8) & 0xFF) / 255; blue = Double(hex & 0xFF) / 255
  }
  public init(red: Double, green: Double, blue: Double) { self.red = red; self.green = green; self.blue = blue }
  /// Relative luminance, as the contrast formula of WCAG 2 defines it.
  public var luminance: Double {
    func linear(_ value: Double) -> Double { value <= 0.03928 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
  }
  public static func contrast(_ a: RGB, _ b: RGB) -> Double {
    let high = max(a.luminance, b.luminance), low = min(a.luminance, b.luminance)
    return (high + 0.05) / (low + 0.05)
  }
}

public enum DesignTokens {
  private static let table: [ColorToken: (light: UInt32, dark: UInt32)] = [
    .canvas: (0xF7F5EF, 0x141210), .surface: (0xFFFDF8, 0x1C1916), .raised: (0xFFFFFF, 0x26221E),
    .fill: (0xEFEBE2, 0x2B2723), .fillPressed: (0xE5E0D5, 0x36312B), .borderSubtle: (0xE3DDD1, 0x2E2A25),
    .rule: (0xECE7DD, 0x24201C), .borderStrong: (0x857E70, 0x8F877A),
    .label: (0x1C1A16, 0xF4EFE6), .labelSecondary: (0x615B4F, 0xB2A999),
    .primary: (0x1C1A16, 0xF4EFE6), .onPrimary: (0xFFFDF8, 0x1C1A16),
    .accent: (0xFF8040, 0xFF8A50), .onAccent: (0x2A1206, 0x2A1206), .accentText: (0xAD4510, 0xFFA577), .accentTint: (0xFFF0E4, 0x3A2216),
    .success: (0x1D7444, 0x58C785), .successTint: (0xE2F3E7, 0x15281B),
    .warning: (0x94490A, 0xEFC15A), .warningTint: (0xFDF1D9, 0x30270F),
    .danger: (0xBF2A22, 0xF2766F), .dangerTint: (0xFDEBE7, 0x391917),
    .info: (0x3A4686, 0xA6B4F2), .infoTint: (0xEBEDF7, 0x1C2136),
  ]
  public static func value(_ token: ColorToken, dark: Bool) -> RGB {
    let pair = table[token]!
    return RGB(dark ? pair.dark : pair.light)
  }
  // Shape and space, in points.
  public static let radiusSmall = 10.0, radiusCard = 20.0, radiusSheet = 26.0
  public static let space1 = 4.0, space2 = 8.0, space3 = 12.0, space4 = 16.0, space5 = 20.0, space6 = 24.0
}
