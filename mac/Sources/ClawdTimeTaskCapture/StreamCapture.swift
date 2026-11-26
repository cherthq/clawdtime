import AppKit
import CoreMedia
import CoreVideo
import Darwin
import DeviceCore
import ScreenCaptureKit
import VideoToolbox

private struct CapturedStreamFrame {
  let buffer: CVPixelBuffer
  let hostTime: UInt64
}

private final class OneFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
  let mailbox = TaskCaptureFrameMailbox<CapturedStreamFrame>()
  let requestedAt: UInt64
  let width: Int
  let height: Int
  init(requestedAt: UInt64, width: Int, height: Int) {
    self.requestedAt = requestedAt; self.width = width; self.height = height
  }
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, buffer.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let info = attachments.first, let status = info[.status] as? Int,
      status == SCFrameStatus.complete.rawValue,
      let pixels = CMSampleBufferGetImageBuffer(buffer),
      let hostTime = info[.displayTime] as? UInt64 else { return }
    guard TaskCaptureStreamPolicy.admits(complete: true, valid: true, frameHostTime: hostTime,
      requestHostTime: requestedAt, callbackHostTime: mach_absolute_time(),
      width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels), expectedWidth: width, expectedHeight: height) else { return }
    mailbox.offer(.success(CapturedStreamFrame(buffer: pixels, hostTime: hostTime)))
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    mailbox.offer(.failure(CancellationError()))
  }
}

/// Experimental acquisition only: one fresh stream, one complete frame, joined
/// stop. A framework lifecycle that cannot be confirmed terminates this owned
/// child rather than allowing a late start to survive into another request.
@MainActor func captureStreamFrame(window: SCWindow, configuration: SCStreamConfiguration,
                                  phase: @escaping @MainActor (TaskCaptureTiming.Phase) -> Void) async throws -> (CGImage, Double) {
  try await captureStreamFrame(filter: SCContentFilter(desktopIndependentWindow: window), configuration: configuration, phase: phase)
}

/// The caller binds this filter to its separate exact-window or selected-display grant.
@MainActor func captureStreamFrame(filter: SCContentFilter, configuration: SCStreamConfiguration,
                                  phase: @escaping @MainActor (TaskCaptureTiming.Phase) -> Void) async throws -> (CGImage, Double) {
  let requestedAt = mach_absolute_time()
  let output = OneFrameOutput(requestedAt: requestedAt, width: configuration.width, height: configuration.height)
  let queue = DispatchQueue(label: "clawdtime.task.exact-frame", qos: .userInitiated)
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
  configuration.queueDepth = 3
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.capturesAudio = false
  let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
  try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: queue)
  let deadline = TaskCaptureDeadline()
  let terminate = DispatchWorkItem {
    if deadline.expire() { _exit(2) }
  }
  // This is a child-process boundary, not an async cancellation claim. No start
  // can remain pending after the owning process has terminated.
  DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + 1.25, execute: terminate)
  let timeout = DispatchWorkItem { output.mailbox.offer(.failure(CancellationError())) }
  DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + .milliseconds(600), execute: timeout)
  defer {
    output.mailbox.invalidate()
    timeout.cancel()
    let now = mach_absolute_time()
    let elapsed = now >= requestedAt ? CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(now - requestedAt)) : .infinity
    if TaskCaptureStreamPolicy.withinLifecycleDeadline(elapsedSeconds: elapsed), deadline.finish() {
      terminate.cancel()
    } else { _exit(2) }
  }
  let frame: CapturedStreamFrame
  do {
    frame = try await TaskCaptureStreamAttempt.acquire(start: {
      phase(.streamStart)
      try await stream.startCapture()
    }, frame: {
      phase(.streamWait)
      return try await output.mailbox.value()
    }, invalidate: { output.mailbox.invalidate() }, stop: {
      phase(.streamStop)
      try await stream.stopCapture()
    })
  } catch TaskCaptureStreamError.cleanupUnconfirmed {
    phase(.refusedStreamStop)
    _exit(2)
  } catch {
    phase(.refusedStreamFrame)
    throw error
  }
  try stream.removeStreamOutput(output, type: .screen)
  var image: CGImage?
  guard VTCreateCGImageFromCVPixelBuffer(frame.buffer, options: nil, imageOut: &image) == noErr, let image else {
    phase(.refusedStreamFrame); throw CancellationError()
  }
  let now = mach_absolute_time()
  guard now >= frame.hostTime else { phase(.refusedStreamFrame); throw CancellationError() }
  let age = CMTimeGetSeconds(CMClockMakeHostTimeFromSystemUnits(now - frame.hostTime))
  guard age.isFinite, age >= 0, age < 1 else { phase(.refusedStreamFrame); throw CancellationError() }
  // Frame time comes from the OS host timestamp, never from arrival/encode time.
  try Task.checkCancellation()
  return (image, Date().timeIntervalSince1970 * 1000 - age * 1000)
}
