import AppKit
import DeviceCore

/// Read-only AX isolation. The installed parent's UI/policy actor never waits
/// synchronously on another app's Accessibility server.
@MainActor final class InstalledPresentationHost {
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var binding: PresentationResolveRequest?
  private var busy=false
  private var idle: Task<Void,Never>?
  private let executable: URL
  private let arguments: [String]
  private let afterJoin: (() async -> Void)?
  init(executable:URL = Bundle.main.executableURL!,arguments:[String] = ["--installed-presentation-resolver"],afterJoin:(() async -> Void)? = nil) {
    self.executable=executable;self.arguments=arguments;self.afterJoin=afterJoin
  }
  func cancel() {
    idle?.cancel();idle=nil
    if let process,process.isRunning { kill(process.processIdentifier,SIGKILL) }
    if !busy,process != nil {
      busy=true
      Task { await self.retire();self.busy=false }
    }
  }
  private func retire() async {
    let retiring=process,oldInput=input,oldOutput=output
    cancel()
    if let retiring { await withCheckedContinuation { done in DispatchQueue.global().async { retiring.waitUntilExit();done.resume() } } }
    if retiring != nil { await afterJoin?() }
    try? oldInput?.close();try? oldOutput?.close()
    if process === retiring { input=nil;output=nil;process=nil;binding=nil }
  }
  private func launch(_ request:PresentationResolveRequest) throws {
    let p=Process(),incoming=Pipe(),outgoing=Pipe()
    p.executableURL=executable;p.arguments=arguments
    p.standardInput=incoming;p.standardOutput=outgoing;p.standardError=FileHandle.nullDevice
    try p.run();process=p;input=incoming.fileHandleForWriting;output=outgoing.fileHandleForReading;binding=request
  }
  private func read() async throws -> [String:Any] {
    guard let output else { throw HelperError(503,"presentation_resolver_unavailable") }
    let data:Data=try await withCheckedThrowingContinuation { done in
      DispatchQueue.global().async {
        do {
          var bytes=Data()
          while bytes.count<=8192 {
            guard let next=try output.read(upToCount:1),!next.isEmpty else { throw HelperError(503,"presentation_resolver_unavailable") }
            if next[0]==10 { done.resume(returning:bytes);return };bytes.append(next)
          }
          throw HelperError(503,"presentation_resolver_unavailable")
        } catch { done.resume(throwing:error) }
      }
    }
    guard let result=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw HelperError(503,"presentation_resolver_unavailable") }
    return result
  }
  func resolve(_ request:PresentationResolveRequest,allowed:@escaping () -> Bool) async throws -> [String:Any] {
    guard !busy else { throw HelperError(409,"presentation_resolver_busy") }
    guard allowed() else { throw HelperError(409,"presentation_authority_unavailable") }
    busy=true;defer { busy=false }
    idle?.cancel();idle=nil
    if process?.isRunning != true || binding.map({ !request.sameBinding($0) }) ?? true { await retire() }
    guard allowed() else { throw HelperError(409,"presentation_authority_unavailable") }
    if process == nil { try launch(request) }
    guard let process,let input else { throw HelperError(503,"presentation_resolver_unavailable") }
    let watchdog=DispatchWorkItem { if process.isRunning { kill(process.processIdentifier,SIGKILL) } }
    // Same read budget as production's remote monitor. A child that cannot
    // complete is killed, never retried or allowed to block the local Stop UI.
    DispatchQueue.global().asyncAfter(deadline:.now()+0.18,execute:watchdog)
    defer { watchdog.cancel() }
    do {
      try input.write(contentsOf:JSONEncoder().encode(request)+Data([10]))
      let response=try await read()
      guard allowed(),response["v"] as? Int == 1,response["requestId"] as? String == request.requestId,
        response["status"] as? String == "resolved",let observation=response["observation"] as? [String:Any] else { throw HelperError(409,"presentation_target_changed") }
      // Retain only until this read's original absolute authority expiry.
      // The initial presentation may wait up to 1.2s for its bracketing frame;
      // an arbitrary shorter idle timer must not race the second read.
      let idleNanoseconds=UInt64(max(0,min(2,request.expiresAt/1000-Date().timeIntervalSince1970))*1_000_000_000)
      idle=Task { [weak self] in
        do { try await Task.sleep(nanoseconds:idleNanoseconds) } catch { return }
        guard let self,!self.busy else { return }
        self.busy=true
        await self.retire()
        self.busy=false
      }
      return observation
    } catch { await retire();throw error }
  }
}
