import Foundation

/// Supported native window structure, not permission to click every role.
/// TextEdit's rich-text chrome includes color wells, ruler markers and a radio
/// group whose value points to its selected child. Unknown structure still
/// invalidates the whole window witness.
public enum LocalTargetTreePolicy {
  public static let roles: Set<String> = [
    "AXWindow", "AXGroup", "AXSplitGroup", "AXScrollArea", "AXToolbar", "AXTabGroup", "AXTab",
    "AXButton", "AXTextField", "AXTextArea", "AXStaticText", "AXCheckBox", "AXRadioButton",
    "AXPopUpButton", "AXComboBox", "AXScrollBar", "AXSlider", "AXMenuButton",
    "AXDisclosureTriangle", "AXSeparator", "AXRuler", "AXValueIndicator", "AXIncrementor",
    "AXGrowArea", "AXRulerMarker", "AXColorWell", "AXRadioGroup",
  ]

  public static func allowsElementValue(role: String, attribute: String) -> Bool {
    role == "AXRadioGroup" && attribute == "AXValue"
  }

  /// TextEdit advertises AXDescription on its document text area but may return
  /// kAXErrorFailure for that optional label. Preserve a distinct error sentinel
  /// in the semantic digest; value, selection, focus and geometry must still read.
  public static func allowsUnavailableDescription(bundleId: String, role: String, attribute: String, status: Int32) -> Bool {
    bundleId == "com.apple.TextEdit" && role == "AXTextArea" && attribute == "AXDescription" && status == -25200
  }

  /// An AX reference is semantic evidence only when it belongs to this exact
  /// completely captured window. Never accept a reference to another window.
  public static func referencesContained<Element>(
    _ references: [Element], in nodes: [Element], same: (Element, Element) -> Bool
  ) -> Bool {
    references.allSatisfy { reference in nodes.contains { same(reference, $0) } }
  }
}
