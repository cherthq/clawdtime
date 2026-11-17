import XCTest
import DeviceCore
@testable import ClawdTimeCompanion

final class InstalledPresentationHostTests: XCTestCase {
  func request(lifetime:Double = 1.5) throws -> PresentationResolveRequest {
    let value:[String:Any] = ["v":1,"requestId":UUID().uuidString,"op":"resolve","sessionId":"session","leaseId":"lease","authorityRequestId":"request","processIdentity":"unqualified","epoch":0,"cursor":0,"policyRevision":1,"displayId":1,"expiresAt":Date().timeIntervalSince1970*1000+lifetime*1000,"target":["pid":1,"bundleId":"com.apple.finder","windowId":1]]
    return try PresentationResolveRequest.decode(JSONSerialization.data(withJSONObject:value),now:Date().timeIntervalSince1970*1000)
  }
  @MainActor func testHungChildDoesNotBlockStopAndIsJoined() async throws {
    let host=InstalledPresentationHost(executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:["-u","-c","import sys,time; sys.stdin.readline(); time.sleep(30)"])
    let began=Date();var permitted=true
    let task=Task { try await host.resolve(self.request(),allowed:{permitted}) }
    try await Task.sleep(nanoseconds:20_000_000)
    permitted=false;host.cancel()
    do { _=try await task.value;XCTFail("Stopped child returned metadata") } catch {}
    XCTAssertLessThan(Date().timeIntervalSince(began),1)
  }
  @MainActor func testOriginalReadBudgetKillsHungChildWithoutStop() async throws {
    let host=InstalledPresentationHost(executable:URL(fileURLWithPath:"/usr/bin/python3"),arguments:["-u","-c","import sys,time; sys.stdin.readline(); time.sleep(30)"])
    let began=Date()
    do { _=try await host.resolve(self.request(),allowed:{true});XCTFail("Hung read returned") } catch {}
    XCTAssertLessThan(Date().timeIntervalSince(began),1)
  }
  @MainActor func testRevokedAuthorityDiscardsLateMetadata() async throws {
    let code = #"{ line=$0; sub(/^.*"requestId":"/,"",line); sub(/".*$/,"",line); system("sleep 0.04"); print "{\"v\":1,\"requestId\":\"" line "\",\"status\":\"resolved\",\"observation\":{}}"; fflush(); }"#
    let host=InstalledPresentationHost(executable:URL(fileURLWithPath:"/usr/bin/awk"),arguments:[code])
    var permitted=true
    let task=Task { try await host.resolve(self.request(),allowed:{permitted}) }
    try await Task.sleep(nanoseconds:10_000_000);permitted=false
    do { _=try await task.value;XCTFail("Revoked metadata was returned") }
    catch let error as HelperError { XCTAssertEqual(error.message,"presentation_target_changed") }
  }
  @MainActor func testIdleRetirementOwnsSlotUntilExactChildJoinCompletes() async throws {
    // awk is a tiny local pipe fixture; unlike a Python launcher its startup
    // does not consume the deliberately unchanged 180ms production read budget.
    let code = #"{ line=$0; sub(/^.*"requestId":"/,"",line); sub(/".*$/,"",line); print "{\"v\":1,\"requestId\":\"" line "\",\"status\":\"resolved\",\"observation\":{}}"; fflush(); }"#
    var joining=false;var release:CheckedContinuation<Void,Never>?
    let host=InstalledPresentationHost(executable:URL(fileURLWithPath:"/usr/bin/awk"),arguments:[code],afterJoin:{
      if !joining { joining=true;await withCheckedContinuation { release=$0 } }
    })
    var initialReturned=false
    let initial=Task { let result=try await host.resolve(self.request(lifetime:0.12),allowed:{true});initialReturned=true;return result }
    for _ in 0..<100 {
      if joining { break };try await Task.sleep(nanoseconds:10_000_000)
    }
    guard initialReturned else { release?.resume();_ = try? await initial.value;XCTFail("Fixture failed to return before retirement");return }
    XCTAssertTrue(joining)
    do { _=try await host.resolve(self.request(),allowed:{true});XCTFail("New request entered retired child slot") } catch {}
    release?.resume();try await Task.sleep(nanoseconds:20_000_000)
    _=try await host.resolve(self.request(),allowed:{true})
    host.cancel();try await Task.sleep(nanoseconds:20_000_000)
  }
  @MainActor func testBracketingFrameWaitDoesNotRetireUnexpiredReadChild() async throws {
    let code = #"{ line=$0; sub(/^.*"requestId":"/,"",line); sub(/".*$/,"",line); print "{\"v\":1,\"requestId\":\"" line "\",\"status\":\"resolved\",\"observation\":{}}"; fflush(); }"#
    var retirements=0
    let host=InstalledPresentationHost(executable:URL(fileURLWithPath:"/usr/bin/awk"),arguments:[code],afterJoin:{retirements+=1})
    _=try await host.resolve(self.request(),allowed:{true})
    try await Task.sleep(nanoseconds:400_000_000)
    XCTAssertEqual(retirements,0)
    _=try await host.resolve(self.request(),allowed:{true})
    XCTAssertEqual(retirements,0)
    host.cancel()
    for _ in 0..<100 { if retirements == 1 { break };try await Task.sleep(nanoseconds:10_000_000) }
    XCTAssertEqual(retirements,1)
  }

}
