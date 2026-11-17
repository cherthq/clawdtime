import AppKit
import CoreImage
import CoreMedia
import DeviceCore
import ScreenCaptureKit

/// One bounded screen-only stream. No audio, retained frames, or source fallback.
final class CameraSingleFrameStream: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  private let lock = NSLock()
  private var continuation: CheckedContinuation<CGImage, Error>?
  private var stream: SCStream?
  private var timer: DispatchWorkItem?
  private var completed = false

  func capture(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
    try await withCheckedThrowingContinuation { continuation in
      self.continuation = continuation
      let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
      self.stream = stream
      do { try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "clawdtime.camera.frame")) }
      catch { finish(.failure(error)); return }
      let timeout = DispatchWorkItem { [self] in finish(.failure(HelperError(503, "Selected window did not produce a fresh frame within the capture deadline."))) }
      timer = timeout
      DispatchQueue.global().asyncAfter(deadline: .now() + 1.5, execute: timeout)
      stream.startCapture { [self] error in if let error { finish(.failure(error)) } }
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { finish(.failure(error)) }
  func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sampleBuffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
      let buffer = sampleBuffer.imageBuffer else { return }
    lock.lock(); let done = completed; lock.unlock()
    guard !done else { return }
    let image = CIImage(cvPixelBuffer: buffer)
    guard let result = CIContext(options: [.cacheIntermediates: false]).createCGImage(image, from: image.extent) else {
      finish(.failure(HelperError(503, "Selected camera frame could not be decoded."))); return
    }
    finish(.success(result))
  }

  private func finish(_ result: Result<CGImage, Error>) {
    lock.lock()
    guard !completed else { lock.unlock(); return }
    completed = true
    let continuation = self.continuation; self.continuation = nil
    let stream = self.stream; self.stream = nil
    timer?.cancel(); timer = nil
    lock.unlock()
    // Publish only after successful bounded stop acknowledgment. The gate owns
    // the pending image so a missing/late callback cannot retain it indefinitely.
    if let stream, let continuation {
      let gate = CaptureStopGate(result: result) { continuation.resume(with: $0) }
      stream.stopCapture { error in gate.acknowledged(error: error) }
    } else { continuation?.resume(with: result) }
  }
}
