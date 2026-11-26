import AppKit
import ApplicationServices
import DeviceCore

/// The installed parent owns policy and receipts; the disposable child owns AX.
/// AX never executes on the parent's MainActor, so Stop can kill it immediately.
@MainActor final class InstalledNativeHost {
  let store: NativeActivationStore
  private var process: Process?
  private var input: FileHandle?
  private var output: FileHandle?
  private var busy=false
  /// The child executable and its arguments; tests replace them with a scripted child.
  var executable: URL?
  var arguments=["--installed-native-executor"]
  init(url: URL, executable: URL? = nil, arguments: [String] = ["--installed-native-executor"]) throws {
    store=try NativeActivationStore(url:url);self.executable=executable;self.arguments=arguments
  }
  func cancel() {
    // No cloud callback, pipe read or AX wait is on the Stop path. A setter
    // already admitted may have reached the OS; its outcome stays uncertain.
    if let process, process.isRunning { kill(process.processIdentifier,SIGKILL) }
  }
  private func launch() throws {
    let p=Process(), incoming=Pipe(), outgoing=Pipe()
    p.executableURL=executable ?? Bundle.main.executableURL
    p.arguments=arguments
    p.standardInput=incoming; p.standardOutput=outgoing; p.standardError=FileHandle.nullDevice
    // Stop kills the child at any time. A later write to its closed input must
    // fail with EPIPE, never raise SIGPIPE and kill the companion.
    guard fcntl(incoming.fileHandleForWriting.fileDescriptor,F_SETNOSIGPIPE,1) == 0 else { throw HelperError(503,"native_child_pipe") }
    try p.run();process=p;input=incoming.fileHandleForWriting;output=outgoing.fileHandleForReading
  }
  private func join() async {
    cancel()
    if let process { await withCheckedContinuation { done in DispatchQueue.global().async { process.waitUntilExit();done.resume() } } }
    try? input?.close();try? output?.close();input=nil;output=nil;process=nil
  }
  private func line() async throws -> [String:Any] {
    guard let output else { throw HelperError(503,"native_child_missing") }
    let bytes: Data = try await withCheckedThrowingContinuation { done in
      DispatchQueue.global().async {
        do {
          var data=Data()
          while data.count<=8192 {
            guard let next=try output.read(upToCount:1),!next.isEmpty else { throw HelperError(503,"native_child_closed") }
            if next[0]==10 { done.resume(returning:data);return };data.append(next)
          }
          throw HelperError(503,"native_child_bound")
        } catch { done.resume(throwing:error) }
      }
    }
    guard let value=try JSONSerialization.jsonObject(with:bytes) as? [String:Any] else { throw HelperError(503,"native_child_invalid") };return value
  }
  private func exchange(_ value:[String:Any], allowed:() -> Bool, written:() -> Void = {}) async throws -> [String:Any] {
    guard allowed(),let input else { throw HelperError(409,"native_local_authority_changed") }
    try input.write(contentsOf:JSONSerialization.data(withJSONObject:value)+Data([10]))
    written()
    while true {
      let result=try await line()
      if result["localAuthority"] as? Int == 1 {
        let ok=allowed()
        try input.write(contentsOf:Data(ok ? "1\n".utf8 : "0\n".utf8))
        if !ok { cancel() }
        continue
      }
      guard result["v"] as? Int == 1,result["effectAttempted"] is Bool,
        ["qualified","verified","submitted","unknown","rejected"].contains(result["status"] as? String ?? ""),
        result["requestId"] as? String == value["requestId"] as? String else { throw HelperError(503,"native_child_binding") }
      return result
    }
  }
  /// Terminal receipt of a dispatch that ended before the child had the effect
  /// request, so no input was sent. The time is capped at the dispatch deadline,
  /// which is still true because no effect follows.
  private func refusal(_ envelope: NativeActivationEnvelope) -> [String:Any] {
    let now=Date().timeIntervalSince1970*1000
    return ["operationId":envelope.id,"state":"rejected","reason":"native_refused_before_effect",
      "terminalEvidence":["receiptId":UUID().uuidString,"operationId":envelope.id,"fingerprint":envelope.fingerprint,
        "hostId":"clawdtime-installed-native","completedAt":min(now,envelope.nativeExpiresAt ?? now)]]
  }
  func run(_ envelope: NativeActivationEnvelope, dispatch:Bool, allowed:@escaping () -> Bool) async throws -> [String:Any] {
    if let old=try store.existing(envelope) {
      if dispatch,let result=old["result"] as? [String:Any] { return result }
      if !dispatch, let observation=old["observation"] as? [String:Any] { return observation }
    }
    guard !busy,store.unresolved==0,allowed() else { throw HelperError(409,"native_local_authority_unavailable") }
    if dispatch {
      guard envelope.nativeExpiresAt != nil,let old=try store.existing(envelope),let observation=old["observation"] as? [String:Any],
        let prepared=envelope.raw["preparedObservation"] as? [String:Any],
        try JSONSerialization.data(withJSONObject:observation,options:[.sortedKeys]) == JSONSerialization.data(withJSONObject:prepared,options:[.sortedKeys]) else { throw HelperError(409,"native_preparation_changed") }
      try store.dispatch(envelope)
    }
    busy=true
    var result:[String:Any]?
    // Until the child has the effect request, nothing can reach the OS: a
    // failure before it is a refusal, and a failure after it is uncertain.
    var effectRequested=false
    do {
      try launch()
      var wire=envelope.wire(now:Date().timeIntervalSince1970*1000)
      let qualified=try await exchange(wire,allowed:allowed)
      guard allowed(),qualified["status"] as? String == "qualified",let observed=qualified["observation"] as? [String:Any] else { throw HelperError(409,"native_qualification_failed") }
      if !dispatch {
        guard let target=qualified["wireTarget"] as? [String:Any] else { throw HelperError(409,"native_target_invalid") }
        try store.prepare(envelope,observation:observed,target:target);result=observed
      } else {
        let old=try store.existing(envelope)!,prepared=old["observation"] as! [String:Any]
        guard let originalTarget=old["target"] as? [String:Any],let currentTarget=qualified["wireTarget"] as? [String:Any],
          NSDictionary(dictionary:originalTarget).isEqual(to:currentTarget),
          NSDictionary(dictionary:observed["window"] as? [String:Any] ?? [:]).isEqual(to:prepared["window"] as? [String:Any] ?? [:]),
          observed["processIdentity"] as? String == prepared["processIdentity"] as? String,
          NSDictionary(dictionary:observed["windowBounds"] as? [String:Any] ?? [:]).isEqual(to:prepared["windowBounds"] as? [String:Any] ?? [:]),
          envelope.operation["action"] as? String != "raise_window" || observed["appActive"] as? Bool == true else { throw HelperError(409,"native_target_changed") }
        wire["requestId"]=UUID().uuidString;wire["op"]=wire["effect"];wire["target"]=qualified["wireTarget"];wire["targetToken"]=qualified["targetToken"]
        let response=try await exchange(wire,allowed:allowed,written:{ effectRequested=true })
        let state=response["status"] as? String ?? "unknown"
        let outcome=NativeCompletionDecision.state(childStatus:state,responseMatches:true,authorityCurrent:allowed())
        let terminal=outcome != "uncertain"
        var receipt:[String:Any]=["operationId":envelope.id,"state":outcome,
          "reason":outcome == "verified" ? "target_foreground" : terminal ? "host_returned_target_unverified" : "native_completion_unknown"]
        if terminal {
          receipt["terminalEvidence"]=["receiptId":UUID().uuidString,"operationId":envelope.id,"fingerprint":envelope.fingerprint,"hostId":"clawdtime-installed-native","completedAt":Date().timeIntervalSince1970*1000]
          if let observation=response["observation"] { receipt["observation"]=observation }
        }
        result=receipt
      }
    } catch {
      if dispatch && effectRequested { result=["operationId":envelope.id,"state":"uncertain","reason":"native_completion_unknown"] }
      else if dispatch { result=refusal(envelope) }
      else { await join();busy=false;throw error }
    }
    // Completion never clears the physical actor fence until waitpid joined it.
    await join();busy=false
    if dispatch && effectRequested && !allowed(),result?["terminalEvidence"] != nil {
      result?["state"]="returned";result?["reason"]="host_returned_target_unverified";result?.removeValue(forKey:"observation")
    }
    guard let result else { throw HelperError(503,"native_result_unavailable") }
    if dispatch { try store.finish(envelope,result:result) }
    return result
  }
}
