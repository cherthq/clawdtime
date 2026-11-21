import CoreGraphics
import Foundation

/// One element as the Accessibility tree gives it, before it is cleaned.
public struct RawElement: Equatable, Sendable {
  public var role: String
  public var subrole: String?
  /// The text of the element that labels this one.
  public var label: String?
  public var title: String?
  public var description: String?
  /// What an empty field shows.
  public var placeholder: String?
  public var value: String?
  /// In screen points, with the origin at the top left of the main display.
  public var frame: CGRect
  public var enabled: Bool
  public var focused: Bool
  public init(role: String, subrole: String? = nil, label: String? = nil, title: String? = nil, description: String? = nil,
              placeholder: String? = nil, value: String? = nil, frame: CGRect, enabled: Bool = true, focused: Bool = false) {
    self.role = role; self.subrole = subrole; self.label = label; self.title = title; self.description = description
    self.placeholder = placeholder; self.value = value; self.frame = frame; self.enabled = enabled; self.focused = focused
  }
}

/// Cleans what the Accessibility tree says before it leaves the Mac's screen
/// for the worker. Names come from other programs, so every string is one
/// bounded line, and a password field never gives what it holds.
public enum ElementCleaner {
  public static let maxElements = 400, textLimit = 200, roleLimit = 60
  /// Roles whose value says what the element holds: text, a choice, a state.
  static let holders: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider"]
  /// Roles that a person acts on. They are kept even with no name, and first when there are too many.
  static let controls: Set<String> = holders.union(["AXButton", "AXLink", "AXMenuButton", "AXMenuItem", "AXMenuBarItem",
    "AXDisclosureTriangle", "AXIncrementor", "AXColorWell", "AXTab", "AXSegmentedControl", "AXToolbarButton"])

  /// One clean line of at most `limit` UTF-16 units. A longer text ends with an ellipsis.
  public static func line(_ text: String, limit: Int = textLimit) -> String {
    // A field can hold a whole document. Only its start is ever read.
    let scalars = text.unicodeScalars.prefix(limit * 8).map { scalar -> Character in
      switch scalar.properties.generalCategory {
      case .control, .format, .surrogate, .privateUse, .unassigned, .lineSeparator, .paragraphSeparator, .spaceSeparator: return " "
      default: return Character(scalar)
      }
    }
    let collapsed = String(scalars).split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
    guard collapsed.utf16.count > limit else { return collapsed }
    var kept = "", units = 0
    for character in collapsed {
      let width = character.utf16.count
      // One unit stays free for the ellipsis.
      if units + width > limit - 1 { break }
      kept.append(character); units += width
    }
    return kept.trimmingCharacters(in: .whitespaces) + "…"
  }
  /// A password field, by its role or its kind.
  public static func isSecure(role: String, subrole: String?) -> Bool {
    role == "AXSecureTextField" || subrole == "AXSecureTextField"
  }
  /// The element as the contract carries it, or nil for one that says nothing:
  /// no size, outside `bounds`, or a part of the layout with no name.
  public static func element(_ raw: RawElement, id: Int = 0, within bounds: CGRect? = nil) -> ScreenElement? {
    var frame = raw.frame.standardized
    guard frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite, frame.height.isFinite, frame.width >= 1, frame.height >= 1 else { return nil }
    if let bounds {
      // Only the part that shows is given: its middle is a place that a click reaches.
      frame = frame.intersection(bounds)
      guard !frame.isNull, frame.width >= 1, frame.height >= 1 else { return nil }
    }
    let role = line(raw.role, limit: roleLimit)
    let secure = isSecure(role: raw.role, subrole: raw.subrole)
    var names = [raw.label, raw.title, raw.description, raw.placeholder]
    // A text on the screen has no name: what it says is its name.
    if raw.role == "AXStaticText" && !secure { names.append(raw.value) }
    let title = names.lazy.compactMap { $0 }.map { line($0) }.first(where: { !$0.isEmpty }) ?? ""
    let value = !secure && holders.contains(raw.role) ? raw.value.map { line($0) } : nil
    guard !title.isEmpty || value != nil || controls.contains(raw.role) || secure else { return nil }
    func tenth(_ number: CGFloat) -> Double { (Double(number) * 10).rounded() / 10 }
    return ScreenElement(id: id, role: role, title: title, value: value, x: tenth(frame.minX), y: tenth(frame.minY),
                         w: tenth(frame.width), h: tenth(frame.height), enabled: raw.enabled, focused: raw.focused, secure: secure)
  }
  /// Every element that says something, in the order of the tree, numbered from
  /// zero. With more than the contract holds, the ones that a person acts on stay first.
  public static func clean(_ raw: [RawElement], within bounds: CGRect? = nil) -> [ScreenElement] {
    var kept = raw.compactMap { element($0, within: bounds) }
    if kept.count > maxElements {
      var chosen = Set(kept.indices.filter { controls.contains(kept[$0].role) || kept[$0].secure }.prefix(maxElements))
      for index in kept.indices where chosen.count < maxElements { chosen.insert(index) }
      kept = kept.indices.filter(chosen.contains).map { kept[$0] }
    }
    return kept.enumerated().map { index, item in
      ScreenElement(id: index, role: item.role, title: item.title, value: item.value, x: item.x, y: item.y, w: item.w, h: item.h,
                    enabled: item.enabled, focused: item.focused, secure: item.secure)
    }
  }
}
