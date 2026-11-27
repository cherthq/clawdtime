import AppKit
import ClawdTimeAppCore
import SwiftUI

/// The app's colors in light and dark mode, from the brand palette, and its motion.
enum Theme {
  static func nsColor(_ token: Brand.Token) -> NSColor {
    NSColor(name: nil) { appearance in
      let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
      let value = Brand.value(token, dark: dark)
      return NSColor(srgbRed: value.red, green: value.green, blue: value.blue, alpha: 1)
    }
  }
  static func color(_ token: Brand.Token) -> Color { Color(nsColor: nsColor(token)) }

  static let background = color(.background)
  static let surface = color(.surface)
  static let text = color(.text)
  static let secondaryText = color(.secondaryText)
  static let primary = color(.primary)
  static let onPrimary = color(.onPrimary)
  static let tint = color(.tint)
  static let onTint = color(.onTint)
  static let line = color(.line)
  static let danger = color(.danger)
  static let onDanger = color(.onDanger)

  /// One spring for every step change.
  static let spring = Animation.spring(response: 0.48, dampingFraction: 0.86)
  static let quick = Animation.spring(response: 0.3, dampingFraction: 0.9)
}

/// The pill buttons of the window.
struct PillStyle: ButtonStyle {
  enum Kind { case primary, secondary, danger }
  var kind: Kind
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 13, weight: .semibold))
      .padding(.horizontal, kind == .danger ? 14 : 18)
      .frame(minHeight: kind == .danger ? 28 : 34)
      .foregroundStyle(foreground)
      .background(Capsule().fill(background))
      .overlay(Capsule().strokeBorder(border, lineWidth: 1))
      .opacity(isEnabled ? 1 : 0.45)
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
      .animation(Theme.quick, value: configuration.isPressed)
      .contentShape(Capsule())
  }
  private var foreground: Color {
    switch kind {
    case .primary: Theme.onPrimary
    case .secondary: Theme.text
    case .danger: Theme.danger
    }
  }
  private var background: Color {
    switch kind {
    case .primary: Theme.primary
    case .secondary: Theme.surface
    case .danger: Theme.surface
    }
  }
  private var border: Color {
    switch kind {
    case .primary: .clear
    case .secondary: Theme.line
    case .danger: Theme.danger.opacity(0.55)
    }
  }
}
