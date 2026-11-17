import AppKit
import CoreImage
import CoreMedia
import CryptoKit
import DeviceCore
import ScreenCaptureKit

/// Local-preview transport only. No configuration, listener, lease or input API.
final class CameraDisplayStream: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  struct Sample { let image: CGImage; let capturedAt: Date; let uptime: Double; let id: String }
  private let latest = LatestCapture<Sample>()
  private let context = CIContext(options: [.cacheIntermediates: false])
  private var stream: SCStream?
  private var filter: SCContentFilter?
  private var configuration: SCStreamConfiguration?
  private var geometry: CameraGeometry?
  private var selected: CameraSurface?
  private var stopped = false
  private let watchdogLock = NSLock()
  private var lastRequest = ProcessInfo.processInfo.systemUptime
  private var watchdog: DispatchSourceTimer?
  private var failureReported = false
  private var snapshotActive = false
  private var snapshotCount = 0

  private func report(_ reason: String, error: Error? = nil, authorityStage: String? = nil) {
    watchdogLock.lock()
    guard !failureReported else { watchdogLock.unlock(); return }
    failureReported = true
    let active = snapshotActive; let count = snapshotCount
    watchdogLock.unlock()
    var line = "Camera stream unavailable: \(reason)"
    if let native = error as NSError?, native.domain == SCStreamErrorDomain, (-99999...99999).contains(native.code) {
      line += " native_domain=screen_capture_kit native_code=\(native.code)"
    }
    if let authorityStage { line += " authority_stage=\(authorityStage)" }
    line += " snapshot_active=\(active ? 1 : 0) snapshot_count=\(min(99999, count))\n"
    fputs(line, stderr)
  }

  private func snapshotBegan() {
    watchdogLock.lock(); snapshotActive = true; snapshotCount += 1; watchdogLock.unlock()
  }
  private func snapshotEnded() {
    watchdogLock.lock(); snapshotActive = false; watchdogLock.unlock()
  }

  @MainActor func run(_ surface: CameraSurface) async throws {
    guard surface.kind == "display" else {
      throw HelperError(403, "Display stream requires an explicit display and active unlocked session.")
    }
    if let refusal = LocalSessionGuard().refusal {
      report("authority_changed", authorityStage: refusal.rawValue)
      throw CaptureRefusal(.authorityChanged)
    }
    let (filter, geometry) = try await ScreenCapture().cameraTarget(surface, initial: true)
    self.filter = filter; self.geometry = geometry; selected = surface
    let config = SCStreamConfiguration()
    config.width = geometry.width; config.height = geometry.height
    config.showsCursor = false; config.capturesAudio = false
    config.queueDepth = 3; config.minimumFrameInterval = CMTime(value: 1, timescale: 15)
    self.configuration = config
    let stream = SCStream(filter: filter, configuration: config, delegate: self)
    self.stream = stream
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "clawdtime.preview.display"))
    let began = ProcessInfo.processInfo.systemUptime
    let watchdog = DispatchSource.makeTimerSource(queue: .global())
    watchdog.schedule(deadline: .now() + 0.1, repeating: 0.1)
    watchdog.setEventHandler { [self] in
      watchdogLock.lock(); let idle = ProcessInfo.processInfo.systemUptime - lastRequest; watchdogLock.unlock()
      if idle > 2 || ProcessInfo.processInfo.systemUptime - began > 900 {
        latest.close(); report("deadline"); exit(2)
      }
      Task { @MainActor in
        if let refusal = LocalSessionGuard().refusal { self.report("authority_changed", authorityStage: refusal.rawValue); await self.finish(code: 2) }
      }
    }
    self.watchdog = watchdog; watchdog.resume()
    do { try await stream.startCapture() }
    catch {
      report("stream_start", error: error)
      await finish(code: 2)
      return
    }
    DispatchQueue.global().async { [self] in
      while true {
        // Fixed byte bound, independent of newline placement or parent behavior.
        var bytes = [UInt8]()
        while bytes.count <= 16 {
          let chunk = FileHandle.standardInput.readData(ofLength: 1)
          if chunk.isEmpty { Task { @MainActor in await self.finish(code: 0) }; return }
          if chunk[0] == 10 { break }
          bytes.append(chunk[0])
        }
        guard bytes.count <= 16, let command = String(bytes: bytes, encoding: .utf8), command == "frame" || command == "stop" else {
          Task { @MainActor in await self.finish(code: 2) }; return
        }
        if command == "stop" { Task { @MainActor in await self.finish(code: 0) }; return }
        watchdogLock.lock(); lastRequest = ProcessInfo.processInfo.systemUptime; watchdogLock.unlock()
        let done = DispatchSemaphore(value: 0)
        Task { @MainActor in
          do { try await self.respond() }
          catch {
            let reason = (error as? CaptureRefusal)?.reason.rawValue ?? (error as? CaptureFailure)?.reason.rawValue ?? "capture_failed"
            self.report(reason, error: error)
            await self.finish(code: 2)
          }
          done.signal()
        }
        done.wait()
      }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    latest.close()
    report("stream_interrupted", error: error)
    Task { @MainActor in await finish(code: 2) }
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, buffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      attachments.first?[.status] as? Int == SCFrameStatus.complete.rawValue,
      let pixels = buffer.imageBuffer else { return }
    let age = CMTimeGetSeconds(CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), CMSampleBufferGetPresentationTimeStamp(buffer)))
    guard age.isFinite, age >= 0, age < 2 else { return }
    let uptime = ProcessInfo.processInfo.systemUptime - age
    let date = Date().addingTimeInterval(-age)
    let image = CIImage(cvPixelBuffer: pixels)
    guard let cg = context.createCGImage(image, from: image.extent) else { return }
    latest.put(Sample(image: cg, capturedAt: date, uptime: uptime, id: UUID().uuidString), capturedAt: uptime)
  }

  @MainActor private func validate() throws {
    guard !stopped else { report("authority_changed", authorityStage: "stream_stopped"); throw CaptureRefusal(.authorityChanged) }
    guard let selected, let geometry else { report("authority_changed", authorityStage: "stream_geometry_missing"); throw CaptureRefusal(.authorityChanged) }
    if let refusal = LocalSessionGuard().refusal { report("authority_changed", authorityStage: refusal.rawValue); throw CaptureRefusal(.authorityChanged) }
    guard CGPreflightScreenCaptureAccess() else { report("authority_changed", authorityStage: "permission_missing"); throw CaptureRefusal(.authorityChanged) }
    let mode = CGDisplayCopyDisplayMode(selected.displayId)
    guard CGDisplayIsActive(selected.displayId) != 0,
      DisplayCapturePolicy.unchanged(expectedBounds: CGRect(x: geometry.originX, y: geometry.originY,
        width: geometry.pointWidth, height: geometry.pointHeight), capturedWidth: geometry.width, capturedHeight: geometry.height,
        currentBounds: CGDisplayBounds(selected.displayId), modePixelWidth: mode?.pixelWidth, modePixelHeight: mode?.pixelHeight)
      else { throw CaptureRefusal(.displayChanged) }
  }

  @MainActor private func respond() async throws {
    try validate()
    guard let filter, let configuration, let geometry, let selected else { throw CaptureRefusal(.authorityChanged) }
    var sample = latest.latest(now: ProcessInfo.processInfo.systemUptime, maximumAge: 0.75)
    if sample == nil {
      // Static SCK streams may stop emitting complete frames. Obtain a genuinely
      // new observation of the same display; never refresh a cached timestamp.
      let began = Date(); let uptime = ProcessInfo.processInfo.systemUptime
      snapshotBegan()
      let image: CGImage
      do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) }
      catch { snapshotEnded(); throw error }
      snapshotEnded()
      sample = Sample(image: image, capturedAt: began, uptime: uptime, id: UUID().uuidString)
      if let sample { latest.put(sample, capturedAt: uptime) }
    }
    try validate()
    guard let sample, ProcessInfo.processInfo.systemUptime - sample.uptime < 2 else { throw CaptureRefusal(.frameStale) }
    guard sample.image.width == geometry.width, sample.image.height == geometry.height else { throw CaptureRefusal(.captureDimensions) }
    let bitmap = NSBitmapImageRep(cgImage: sample.image)
    guard let jpeg = bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.85]), jpeg.count <= 2 * 1024 * 1024 else {
      throw HelperError(413, "Native camera frame exceeds budget.")
    }
    let metadata = CameraFrameMetadata(surface: selected, geometryGeneration: try fingerprint(geometry),
      contentRevision: SHA256.hash(data: jpeg).map { String(format: "%02x", $0) }.joined(), source: geometry)
    struct Output: Encodable { let frameId: String; let capturedAt: String; let camera: CameraFrameMetadata; let jpegBase64: String }
    let output = try JSONEncoder().encode(Output(frameId: sample.id, capturedAt: frameCaptureTimestamp(sample.capturedAt),
      camera: metadata, jpegBase64: jpeg.base64EncodedString()))
    try validate()
    guard ProcessInfo.processInfo.systemUptime - sample.uptime < 2 else { throw CaptureRefusal(.frameStale) }
    FileHandle.standardOutput.write(output); FileHandle.standardOutput.write(Data([10]))
  }

  @MainActor private func finish(code: Int32) async {
    guard !stopped else { return }; stopped = true
    latest.close(); watchdog?.cancel(); watchdog = nil
    let stream = self.stream; self.stream = nil
    filter = nil; configuration = nil; geometry = nil
    // Hard termination also bounds a missing native stop acknowledgment.
    DispatchQueue.global().asyncAfter(deadline: .now() + 0.5) { exit(2) }
    if let stream { try? await stream.stopCapture() }
    exit(code)
  }
}
