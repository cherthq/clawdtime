/// A single prepared Accessibility activation request. Capability inspection is
/// read-only and can block; authority must therefore be checked AFTER it, just
/// before the one effect. False return is not proof that no effect occurred.
public enum NativeFrontmostResult: Equatable {
  case unavailable
  case authorityChanged
  case attempted(Bool)
}

public enum NativeFrontmostRequest {
  public static func available(expectedPID: Int32, observedPID: Int32?, attributeSettable: Bool?) -> Bool {
    expectedPID > 0 && observedPID == expectedPID && attributeSettable == true
  }
  @MainActor public static func perform(capability: () -> Bool, authorized: () -> Bool,
      setFrontmost: () -> Bool) -> NativeFrontmostResult {
    guard capability() else { return .unavailable }
    guard authorized() else { return .authorityChanged }
    return .attempted(setFrontmost())
  }
}
