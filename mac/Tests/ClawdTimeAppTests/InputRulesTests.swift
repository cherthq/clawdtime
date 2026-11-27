import XCTest
@testable import ClawdTimeAppCore

final class InputRulesTests: XCTestCase {
  func testAPhoneFieldKeepsWhatAPhoneNumberHasAndSendsDigits() {
    XCTAssertEqual(InputRules.phone("+1 (415) 555-0100"), "+1 (415) 555-0100")
    XCTAssertEqual(InputRules.phone("abc+1 415+555 0100x"), "+1 415555 0100")
    XCTAssertEqual(InputRules.phoneValue("+1 (415) 555-0100"), "+14155550100")
    XCTAssertTrue(InputRules.isPlausiblePhone("+1 415 555 0100"))
    XCTAssertFalse(InputRules.isPlausiblePhone("555"))
    XCTAssertFalse(InputRules.isPlausiblePhone("+1 415 555 0100 0000 0000"))
  }

  func testACodeFieldKeepsDigitsOnly() {
    XCTAssertEqual(InputRules.code("12 34-56"), "123456")
    XCTAssertEqual(InputRules.code("12345678901234"), "1234567890")
    XCTAssertTrue(InputRules.isPlausibleCode("123456"))
    XCTAssertFalse(InputRules.isPlausibleCode("12"))
  }

  func testEachKindSendsItsValueOrNothingYet() {
    XCTAssertEqual(InputRules.value(for: StepInput(kind: .secret), text: "  \(madeUpKey)\n", selection: []), .string(madeUpKey))
    XCTAssertNil(InputRules.value(for: StepInput(kind: .secret), text: "   ", selection: []))
    XCTAssertEqual(InputRules.value(for: StepInput(kind: .text), text: " Stonepad ", selection: []), .string("Stonepad"))
    XCTAssertEqual(InputRules.value(for: StepInput(kind: .phone), text: "+1 415 555 0100", selection: []), .string("+14155550100"))
    XCTAssertNil(InputRules.value(for: StepInput(kind: .phone), text: "41", selection: []))
    XCTAssertEqual(InputRules.value(for: StepInput(kind: .code), text: "123 456", selection: []), .string("123456"))
    XCTAssertNil(InputRules.value(for: StepInput(kind: .confirm), text: "", selection: []))
    let displays = [InputOption(id: "1", label: "Built-in display"), InputOption(id: "2", label: "Studio display")]
    let one = StepInput(kind: .choice, options: displays)
    XCTAssertEqual(InputRules.value(for: one, text: "", selection: ["2"]), .string("2"))
    XCTAssertNil(InputRules.value(for: one, text: "", selection: []))
    XCTAssertNil(InputRules.value(for: one, text: "", selection: ["9"]), "an id the engine did not offer is never sent")
    let many = StepInput(kind: .choice, options: displays, multiple: true)
    XCTAssertEqual(InputRules.value(for: many, text: "", selection: ["2", "1", "9"]), .strings(["1", "2"]))
    XCTAssertEqual(InputRules.value(for: many, text: "", selection: []), .strings([]))
  }
}

final class PaletteTests: XCTestCase {
  func testTheBrandColorsAreTheFourGiven() {
    XCTAssertEqual(Brand.paper.hex, 0xF4F1E8)
    XCTAssertEqual(Brand.ink.hex, 0x252C27)
    XCTAssertEqual(Brand.green.hex, 0x366A43)
    XCTAssertEqual(Brand.mint.hex, 0xC8E6BB)
    XCTAssertEqual(Brand.value(.background, dark: false), Brand.paper)
    XCTAssertEqual(Brand.value(.primary, dark: false), Brand.green)
    XCTAssertEqual(Brand.value(.primary, dark: true), Brand.mint)
  }

  func testTextIsReadableOnItsGroundInBothModes() {
    let pairs: [(Brand.Token, Brand.Token)] = [
      (.text, .background), (.text, .surface), (.secondaryText, .background), (.secondaryText, .surface),
      (.onPrimary, .primary), (.onTint, .tint), (.danger, .surface), (.danger, .background), (.onDanger, .danger),
    ]
    for dark in [false, true] {
      for (text, ground) in pairs {
        let ratio = BrandRGB.contrast(Brand.value(text, dark: dark), Brand.value(ground, dark: dark))
        XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(text) on \(ground), dark \(dark): \(ratio)")
      }
    }
  }
}
