import Foundation
import CryptoKit
import CoreFoundation
import Darwin

/// Installed-helper envelope; this is not a lease and cannot arm the helper.
public struct NativeActivationEnvelope {
  public let raw: [String: Any], operation: [String: Any], binding: [String: Any]
  public let expected: [String: Any], window: [String: Any]
  public let id: String, fingerprint: String, expiresAt: Double, nativeExpiresAt: Double?
  public static func operationFingerprint(_ operation:[String:Any]) throws -> String {
    func fragment(_ value:Any) throws -> String { String(data:try JSONSerialization.data(withJSONObject:value,options:[.fragmentsAllowed,.withoutEscapingSlashes]),encoding:.utf8)! }
    func object(_ value:[String:Any],_ keys:[String]) throws -> String {
      "{" + (try keys.map { key in
        guard let item=value[key] else { throw HelperError(400,"invalid_native_envelope") }
        let encoded:String
        if key == "window",let nested=item as? [String:Any] { encoded=try object(nested,["appId","windowId","ownerPid","displayId"]) }
        else if key == "expected",let nested=item as? [String:Any] { encoded=try object(nested,["requestId","sessionId","leaseId","epoch","cursor","policyRevision","displayId"]) }
        else { encoded=try fragment(item) }
        return try fragment(key)+":"+encoded
      }).joined(separator:",") + "}"
    }
    return SHA256.hash(data:Data(try object(operation,["version","operationId","sceneId","generation","action","window","expected"]).utf8)).map { String(format:"%02x",$0) }.joined()
  }
  private static func integer(_ value:Any?) -> Bool {
    guard let n=value as? NSNumber,CFGetTypeID(n) != CFBooleanGetTypeID() else { return false }
    let d=n.doubleValue;return d.isFinite && d >= 0 && d <= 9007199254740991 && d.rounded() == d
  }
  public static func decode(_ data: Data, now: Double) throws -> Self {
    guard data.count <= 16384, let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any],
      Set(raw.keys).subtracting(["nativeExpiresAt","preparedObservation"]) == ["version","operation","fingerprint","binding"],
      raw["version"] as? Int == 1, let op = raw["operation"] as? [String: Any],
      Set(op.keys) == ["version","operationId","sceneId","generation","action","window","expected"],
      op["version"] as? Int == 1, let id = op["operationId"] as? String, validID(id),
      let scene = op["sceneId"] as? String, validID(scene), let generation = op["generation"] as? Int, generation >= 0,
      let action = op["action"] as? String, ["activate_app","raise_window"].contains(action),
      let w = op["window"] as? [String: Any], Set(w.keys) == ["appId","windowId","ownerPid","displayId"],
      let e = op["expected"] as? [String: Any], Set(e.keys) == ["requestId","sessionId","leaseId","epoch","cursor","policyRevision","displayId"],
      let b = raw["binding"] as? [String: Any], Set(b.keys) == ["mediaSessionId","pairingId","deviceId","memberId","expiresAt"],
      ["mediaSessionId","pairingId","deviceId","memberId"].allSatisfy({ (b[$0] as? String).map(validID) == true }),
      let expiry = b["expiresAt"] as? Double, expiry.isFinite, expiry > now, expiry <= now + 20000,
      let hash = raw["fingerprint"] as? String, hash.count == 64, hash.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
      let app = w["appId"] as? String, let pid = w["ownerPid"] as? Int32,
      let window = w["windowId"] as? String, let wid = UInt32(window), String(wid) == window,
      let display = w["displayId"] as? UInt32, display == e["displayId"] as? UInt32,
      ["requestId","sessionId","leaseId"].allSatisfy({ (e[$0] as? String).map(validID) == true }),
      let epoch = e["epoch"] as? Int, epoch > 0, let cursor = e["cursor"] as? Int, cursor >= 0,
      let revision = e["policyRevision"] as? Int, revision > 0 else { throw HelperError(400,"invalid_native_envelope") }
    guard integer(raw["version"]),["version","generation"].allSatisfy({ integer(op[$0]) }),
      ["ownerPid","displayId"].allSatisfy({ integer(w[$0]) }),
      ["epoch","cursor","policyRevision","displayId"].allSatisfy({ integer(e[$0]) }),
      try operationFingerprint(op) == hash else { throw HelperError(400,"native_fingerprint_or_integer_invalid") }
    let nativeExpiry = raw["nativeExpiresAt"] as? Double
    if raw["nativeExpiresAt"] != nil && (nativeExpiry == nil || !nativeExpiry!.isFinite || nativeExpiry! <= now || nativeExpiry! > min(expiry,now+2000)) { throw HelperError(409,"native_expired") }
    let request: [String: Any] = ["v":1,"requestId":id,"op":"qualify","effect":action == "activate_app" ? "activate" : "raise",
      "authorityRequestId":e["requestId"]!,"sessionId":e["sessionId"]!,"leaseId":e["leaseId"]!,"executorEpoch":epoch,"cursor":cursor,
      "policyRevision":revision,"displayId":display,"expiresAt":min(expiry,now+2000),"target":["pid":pid,"bundleId":app,"windowId":wid]]
    let probe = try JSONDecoder().decode(PreviewNativeRequest.self,from: JSONSerialization.data(withJSONObject:request))
    guard probe.valid(now:now) else { throw HelperError(400,"invalid_native_target") }
    return Self(raw:raw,operation:op,binding:b,expected:e,window:w,id:id,fingerprint:hash,expiresAt:expiry,nativeExpiresAt:nativeExpiry)
  }
  public func matches(_ lease: Lease, device: String, now: Date) -> Bool {
    lease.deviceId == device && binding["deviceId"] as? String == device && binding["memberId"] as? String == lease.memberId
      && expected["leaseId"] as? String == lease.id && expected["sessionId"] as? String == lease.sessionId
      && expected["epoch"] as? Int == lease.executorEpoch && expected["policyRevision"] as? Int == lease.policyRevision
      && expected["displayId"] as? UInt32 == lease.displayId && lease.protocolVersion == 2 && lease.executor == "native"
      && lease.mode == "view" && lease.cameraVersion == 1 && lease.surface?.kind == "display"
      && lease.surface?.displayId == lease.displayId && expiresAt <= lease.expiresAt.timeIntervalSince1970*1000
      && now.timeIntervalSince1970*1000 < (nativeExpiresAt ?? expiresAt)
  }
  public var baseHash: String {
    var value = raw; value.removeValue(forKey:"nativeExpiresAt"); value.removeValue(forKey:"preparedObservation")
    return SHA256.hash(data: try! JSONSerialization.data(withJSONObject:value,options:[.sortedKeys])).map { String(format:"%02x",$0) }.joined()
  }
  public func wire(now: Double) -> [String: Any] {
    ["v":1,"requestId":UUID().uuidString,"op":"qualify","effect":operation["action"] as? String == "activate_app" ? "activate" : "raise",
      "authorityRequestId":expected["requestId"]!,"sessionId":expected["sessionId"]!,"leaseId":expected["leaseId"]!,
      "executorEpoch":expected["epoch"]!,"cursor":expected["cursor"]!,"policyRevision":expected["policyRevision"]!,
      "displayId":expected["displayId"]!,"expiresAt":nativeExpiresAt ?? min(expiresAt,now+2000),
      "target":["pid":window["ownerPid"]!,"bundleId":window["appId"]!,"windowId":UInt32(window["windowId"] as! String)!]]
  }
}

/// Hash/metadata-only durable reservations. Independent directory lock prevents two input hosts.
public final class NativeActivationStore {
  private let url: URL, lock: ReceiptLock
  private var entries: [String:[String:Any]]
  private var poisoned=false
  public init(url: URL) throws {
    self.url=url; lock=try ReceiptLock(folder:url.deletingLastPathComponent())
    entries = [:]
    if FileManager.default.fileExists(atPath:url.path) {
      guard let data = try LegacyReceiptReconciliation.privateData(url,optional:false), let value = try JSONSerialization.jsonObject(with:data) as? [String:[String:Any]] else { throw HelperError(503,"native_receipt_invalid") }
      for (id,record) in value {
        guard validID(id), let phase=record["phase"] as? String, ["prepared","dispatching","uncertain","complete"].contains(phase),
          let lease=record["leaseId"] as? String, validID(lease),
          ["baseHash","fingerprint"].allSatisfy({ (record[$0] as? String).map { $0.count == 64 && $0.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) } } == true }),
          record["observation"] is [String:Any],record["target"] is [String:Any],
          Set(record.keys).subtracting(["result","nativeExpiresAt"]) == ["baseHash","leaseId","fingerprint","phase","observation","target"],
          phase == "prepared" || record["result"] is [String:Any] else { throw HelperError(503,"native_receipt_invalid") }
      }
      entries=value
      for (id,var value) in entries where value["phase"] as? String == "dispatching" {
        value["phase"]="uncertain"; value["result"]=["operationId":id,"state":"uncertain","reason":"native_process_interrupted"]; entries[id]=value
      }
    }
    try commit()
  }
  public var unresolved: Int { (poisoned ? 1 : 0) + entries.values.filter { ["dispatching","uncertain"].contains($0["phase"] as? String ?? "") }.count }
  public func existing(_ e: NativeActivationEnvelope) throws -> [String:Any]? {
    guard !poisoned else { throw HelperError(503,"native_receipt_storage_uncertain") }
    guard let old=entries[e.id] else { return nil }
    guard old["baseHash"] as? String == e.baseHash else { throw HelperError(409,"native_id_conflict") }
    return old
  }
  public func receipt(id: String, leaseId: String) throws -> [String:Any] {
    guard !poisoned else { throw HelperError(503,"native_receipt_storage_uncertain") }
    guard let old=entries[id],old["leaseId"] as? String == leaseId,let result=old["result"] as? [String:Any] else { throw HelperError(404,"native_receipt_unavailable") }; return result
  }
  public func prepare(_ e: NativeActivationEnvelope, observation:[String:Any], target:[String:Any]) throws {
    guard entries[e.id] == nil else { throw HelperError(409,"native_operation_retired") }
    guard entries.count < 10000, unresolved == 0 else { throw HelperError(409,"native_unresolved") }
    let parsed=try JSONDecoder().decode(PreviewNativeTarget.self,from:JSONSerialization.data(withJSONObject:target))
    guard parsed.valid,parsed.bounds != nil else { throw HelperError(400,"native_target_invalid") }
    entries[e.id] = ["target":target,"baseHash":e.baseHash,"leaseId":e.expected["leaseId"]!,"fingerprint":e.fingerprint,"phase":"prepared","observation":observation]
    try commit()
  }
  public func dispatch(_ e: NativeActivationEnvelope) throws {
    guard var old=try existing(e),old["phase"] as? String == "prepared", unresolved == 0 else { throw HelperError(409,"native_unresolved") }
    old["phase"]="dispatching";old["nativeExpiresAt"]=e.nativeExpiresAt;old["result"]=["operationId":e.id,"state":"uncertain","reason":"native_completion_pending"];entries[e.id]=old;try commit()
  }
  public func finish(_ e: NativeActivationEnvelope,result:[String:Any]) throws {
    guard var old=try existing(e),old["phase"] as? String == "dispatching",
      result["operationId"] as? String == e.id,let state=result["state"] as? String,
      ["rejected","returned","verified","uncertain"].contains(state) else { throw HelperError(409,"native_reservation_missing") }
    if state == "uncertain" {
      guard result["terminalEvidence"] == nil else { throw HelperError(409,"native_terminal_invalid") }
    } else {
      guard let terminal=result["terminalEvidence"] as? [String:Any],
        terminal["operationId"] as? String == e.id,terminal["fingerprint"] as? String == e.fingerprint,
        terminal["hostId"] as? String == "clawdtime-installed-native",
        (terminal["receiptId"] as? String).map(validID) == true,
        let completed=terminal["completedAt"] as? Double,completed.isFinite,
        let deadline=e.nativeExpiresAt,completed >= deadline-2000,completed <= (state == "returned" ? Date().timeIntervalSince1970*1000+1000 : deadline) else { throw HelperError(409,"native_terminal_invalid") }
    }
    old["phase"]=state == "uncertain" ? "uncertain" : "complete";old["result"]=result;entries[e.id]=old;try commit()
  }
  private func commit() throws {
    do { try persist() } catch { poisoned=true;throw error }
  }
  private func persist() throws {
    let data=try JSONSerialization.data(withJSONObject:entries,options:[.sortedKeys])
    let temp=url.deletingLastPathComponent().appendingPathComponent(".native-"+UUID().uuidString)
    let fd=open(temp.path,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW,0o600)
    guard fd>=0 else { throw HelperError(503,"native_receipt_write_failed") }
    defer { close(fd);unlink(temp.path) }
    try data.withUnsafeBytes { raw in
      var offset=0
      while offset<data.count { let n=write(fd,raw.baseAddress!.advanced(by:offset),data.count-offset);guard n>0 else { throw HelperError(503,"native_receipt_write_failed") };offset+=n }
    }
    guard fsync(fd)==0,rename(temp.path,url.path)==0 else { throw HelperError(503,"native_receipt_write_failed") }
    let dir=open(url.deletingLastPathComponent().path,O_RDONLY);guard dir>=0 else { throw HelperError(503,"native_receipt_write_failed") };defer { close(dir) }
    guard fsync(dir)==0 else { throw HelperError(503,"native_receipt_write_failed") }
  }
}

/// A matching child return retires the actor, never proves intended UI success.
public enum NativeCompletionDecision {
  public static func state(childStatus:String?, responseMatches:Bool, authorityCurrent:Bool) -> String {
    guard responseMatches,let status=childStatus,["verified","submitted","unknown","rejected"].contains(status) else { return "uncertain" }
    if status == "verified" && authorityCurrent { return "verified" }
    if status == "rejected" && authorityCurrent { return "rejected" }
    return "returned"
  }
}
