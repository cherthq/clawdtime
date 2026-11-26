import XCTest
@testable import DeviceCore

final class ProcessLifetimeIdentityTests: XCTestCase {
  private func foundation(_ date: Double? = 1234567.125, pid: Int32 = 42, bundle: String = "com.apple.TextEdit") -> ProcessLifetimeIdentity? {
    ProcessLifetimeIdentity.resolve(pid: pid, bundleId: bundle, launchTime: date)
  }
  private func kernel(seconds: Int64? = 1234567, microseconds: Int64? = 125000,
      returnedPID: Int32? = 42, pid: Int32 = 42, bundle: String = "com.apple.finder") -> ProcessLifetimeIdentity? {
    ProcessLifetimeIdentity.resolve(pid: pid, bundleId: bundle, launchTime: nil,
      kernelPID: returnedPID, kernelSeconds: seconds, kernelMicroseconds: microseconds)
  }
  func testFoundationPreferredAndStableAcrossOtherMetadataAvailability() {
    let value = foundation()
    XCTAssertNotNil(value); XCTAssertEqual(value?.source, "launch_date")
    XCTAssertEqual(value, foundation())
    XCTAssertEqual(value, ProcessLifetimeIdentity.resolve(pid: 42, bundleId: "com.apple.TextEdit", launchTime: 1234567.125,
      kernelPID: 42, kernelSeconds: 1234567, kernelMicroseconds: 125000))
    XCTAssertEqual(value?.stableMaterial, foundation()?.stableMaterial)
  }
  func testKernelFallbackIsStableButNeverPIDOnly() {
    let value = kernel()
    XCTAssertNotNil(value); XCTAssertEqual(value?.source, "kernel_start")
    XCTAssertEqual(value, kernel()); XCTAssertEqual(value?.stableMaterial, kernel()?.stableMaterial)
    XCTAssertNotEqual(value, kernel(seconds: 1234568))
    XCTAssertNotEqual(value, kernel(microseconds: 125001))
    XCTAssertNotEqual(value, kernel(returnedPID: 43, pid: 43))
    XCTAssertNotEqual(value, kernel(bundle: "com.apple.TextEdit"))
  }
  func testFoundationReuseAndProviderChangesRefuseEquality() {
    XCTAssertNotEqual(foundation(), foundation(1234568.125))
    XCTAssertNotEqual(foundation(), foundation(pid: 43))
    XCTAssertNotEqual(foundation(), foundation(bundle: "com.apple.finder"))
    // Even matching wall-clock start values from different providers cannot
    // silently replace the originally retained lifetime witness.
    XCTAssertNotEqual(foundation(), kernel(bundle: "com.apple.TextEdit"))
    XCTAssertNotEqual(foundation()?.stableMaterial, kernel(bundle: "com.apple.TextEdit")?.stableMaterial)
  }
  func testMissingMalformedOrWrongPIDKernelMetadataRefuses() {
    XCTAssertNil(foundation(nil)); XCTAssertNil(foundation(.nan)); XCTAssertNil(foundation(.infinity))
    XCTAssertNil(foundation(0)); XCTAssertNil(foundation(-1)); XCTAssertNil(foundation(pid: 0))
    XCTAssertNil(kernel(seconds: nil)); XCTAssertNil(kernel(seconds: 0)); XCTAssertNil(kernel(seconds: -1))
    XCTAssertNil(kernel(microseconds: nil)); XCTAssertNil(kernel(microseconds: -1)); XCTAssertNil(kernel(microseconds: 1_000_000))
    XCTAssertNil(kernel(returnedPID: nil)); XCTAssertNil(kernel(returnedPID: 43)); XCTAssertNil(kernel(pid: 0))
    XCTAssertNotNil(kernel(microseconds: 0)); XCTAssertNotNil(kernel(microseconds: 999999))
    for malformed in [Double.nan, .infinity, 0, -1] {
      XCTAssertNil(ProcessLifetimeIdentity.resolve(pid: 42, bundleId: "com.apple.finder", launchTime: malformed,
        kernelPID: 42, kernelSeconds: 1234567, kernelMicroseconds: 125000))
    }
  }
}
