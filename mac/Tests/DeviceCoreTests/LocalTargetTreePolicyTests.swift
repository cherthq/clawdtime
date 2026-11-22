import XCTest
@testable import DeviceCore

final class LocalTargetTreePolicyTests: XCTestCase {
  func testRichTextChromeCanBeWitnessedWithoutAcceptingUnknownStructure() {
    // The blank TextEdit document's 48-node native tree contains all three.
    for role in ["AXRulerMarker", "AXColorWell", "AXRadioGroup"] {
      XCTAssertTrue(LocalTargetTreePolicy.roles.contains(role))
    }
    for role in ["AXSecureTextField", "AXUnknown", "AXWebArea", "AXTable"] {
      XCTAssertFalse(LocalTargetTreePolicy.roles.contains(role))
    }
  }

  func testOnlyRadioGroupValueCanContainAnElementReference() {
    XCTAssertTrue(LocalTargetTreePolicy.allowsElementValue(role: "AXRadioGroup", attribute: "AXValue"))
    for role in ["AXTextArea", "AXTextField", "AXColorWell", "AXRadioButton", "AXUnknown"] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsElementValue(role: role, attribute: "AXValue"))
    }
    for attribute in ["AXTitle", "AXDescription", "AXHelp", "AXChildren"] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsElementValue(role: "AXRadioGroup", attribute: attribute))
    }
  }

  func testRadioValueMustReferenceAnElementInTheSameCompleteWindow() {
    let capturedWindow = ["window", "text", "radio-group", "left", "center", "right"]
    XCTAssertTrue(LocalTargetTreePolicy.referencesContained(["left"], in: capturedWindow, same: ==))
    XCTAssertFalse(LocalTargetTreePolicy.referencesContained(["other-window-radio"], in: capturedWindow, same: ==))
    XCTAssertFalse(LocalTargetTreePolicy.referencesContained(["left", "missing-selected-child"], in: capturedWindow, same: ==))
    XCTAssertFalse(LocalTargetTreePolicy.referencesContained(["left"], in: [String](), same: ==))
  }

  func testTextEditMissingOptionalDescriptionDoesNotRelaxCriticalWitnessReads() {
    XCTAssertTrue(LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: "com.apple.TextEdit", role: "AXTextArea", attribute: "AXDescription", status: -25200))
    for attribute in ["AXValue", "AXSelectedTextRange", "AXFocused", "AXPosition", "AXSize", "AXNumberOfCharacters", "AXRole"] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: "com.apple.TextEdit", role: "AXTextArea", attribute: attribute, status: -25200))
    }
    for bundle in ["com.example.other", "com.apple.mail", "com.apple.TextEdit.extra"] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: bundle, role: "AXTextArea", attribute: "AXDescription", status: -25200))
    }
    for role in ["AXTextField", "AXSecureTextField", "AXButton"] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: "com.apple.TextEdit", role: role, attribute: "AXDescription", status: -25200))
    }
    for status: Int32 in [-25201, -25204, -25205, 0] {
      XCTAssertFalse(LocalTargetTreePolicy.allowsUnavailableDescription(bundleId: "com.apple.TextEdit", role: "AXTextArea", attribute: "AXDescription", status: status))
    }
  }
}
