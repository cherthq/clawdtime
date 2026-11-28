import AVFoundation
import AppKit
import os
import TaskPanelCore

/// One spoken conversation with ClawdTime: listen for a sentence, send it, play
/// the answer, listen again. It never listens while it speaks.
final class VoiceController: NSObject, AVAudioPlayerDelegate {
  enum Phase: Equatable { case off, listening, thinking, speaking }
  private(set) var phase = Phase.off { didSet { if phase != oldValue { onChange?() } } }
  /// Off: no sound of the room leaves the Mac. No buffer heard from now on goes into a recording, so a sentence
  /// that the person began ends with what was heard before.
  var micOn = true {
    didSet {
      if micOn != oldValue { latch.set(on: micOn) }
      onChange?()
    }
  }
  /// The gate of the microphone, shared with the audio thread that writes the recording.
  private let latch = MicrophoneLatch()
  /// It speaks its answers unless the person turned that off in Settings. The speaker button changes it for now.
  var speakerOn = PanelPreferences.voiceReplies(UserDefaults.standard.object(forKey: PanelPreferences.Key.voiceReplies)) {
    didSet {
      if !speakerOn, phase == .speaking { player?.stop(); player = nil; listen() }
      onChange?()
    }
  }
  /// The folder that the task service names for recordings and spoken answers.
  var directory: URL?
  var onChange: (() -> Void)?
  var onError: ((String) -> Void)?
  /// Sends one recording by its file name. Returns the spoken answer's file, when there is one.
  var answer: ((String) async -> URL?)?
  private var meter = VoiceMeter()
  private var activity = VoiceActivity()
  private let engine = AVAudioEngine()
  private var file: AVAudioFile?
  private var recording: URL?
  private var player: AVAudioPlayer?
  private var meterTimer: Timer?

  /// 0 to 1: the person's voice while it listens, ClawdTime's own while it speaks.
  var level: Double { phase == .listening || phase == .speaking ? meter.level : 0 }

  func start() {
    guard phase == .off else { return }
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: listen()
    case .notDetermined:
      AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
        DispatchQueue.main.async {
          if granted { self?.listen() } else { self?.onError?("The microphone was not allowed. ClawdTime cannot hear you.") }
        }
      }
    default:
      onError?("The microphone is off for ClawdTime. Allow it in System Settings, Privacy and Security, Microphone.")
    }
  }
  func stop() {
    halt(keep: false)
    meterTimer?.invalidate(); meterTimer = nil
    player?.stop(); player = nil
    meter.rest(); phase = .off
  }

  private func halt(keep: Bool) {
    engine.inputNode.removeTap(onBus: 0)
    if engine.isRunning { engine.stop() }
    // The file is complete on disk before its name is sent to the service.
    if #available(macOS 15.0, *) { file?.close() }
    file = nil
    if !keep, let recording { try? FileManager.default.removeItem(at: recording) }
    if !keep { recording = nil }
  }
  private func listen() {
    halt(keep: false)
    guard let directory else { onError?("The task service gave no place for recordings."); phase = .off; return }
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else { onError?("No microphone was found."); phase = .off; return }
    let url = directory.appendingPathComponent("rec-\(Int(Date().timeIntervalSince1970 * 1000)).wav")
    // 16 bit samples at the microphone's own rate: a sentence stays a small file.
    let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate, AVNumberOfChannelsKey: format.channelCount,
      AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false]
    do { file = try AVAudioFile(forWriting: url, settings: settings, commonFormat: format.commonFormat, interleaved: format.isInterleaved) }
    catch { onError?("A recording could not be started."); phase = .off; return }
    recording = url; activity.reset(); meter.rest()
    let rate = format.sampleRate
    // The tap runs on the audio thread: it writes to the file it was given, never to a property.
    let out = file, gate = latch
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, when in
      var sum: Float = 0
      let count = Int(buffer.frameLength)
      if let samples = buffer.floatChannelData, count > 0 {
        for index in 0..<count { let value = samples[0][index]; sum += value * value }
        sum = (sum / Float(count)).squareRoot()
      }
      let seconds = Double(count) / rate
      // Only what was heard with the microphone on goes into the file that is sent.
      if gate.admits(when, seconds: seconds) { try? out?.write(from: buffer) }
      DispatchQueue.main.async { self?.heard(rms: Double(sum), seconds: seconds) }
    }
    do { try engine.start(); phase = .listening }
    catch { halt(keep: false); onError?("The microphone could not start."); phase = .off }
  }
  private func heard(rms: Double, seconds: Double) {
    guard phase == .listening else { return }
    // A muted microphone hears nothing: no level, and no sentence.
    meter.feed(rms: micOn ? rms : 0)
    switch activity.feed(level: micOn ? meter.level : 0, seconds: seconds) {
    case .ended: send()
    case .discard: listen()
    default: break
    }
  }
  private func send() {
    guard let url = recording else { return }
    halt(keep: true); recording = nil
    meter.rest(); phase = .thinking
    Task { @MainActor in
      let reply = await self.answer?(url.lastPathComponent)
      // The service removes the recording. If it could not be reached, the file goes here.
      try? FileManager.default.removeItem(at: url)
      guard self.phase == .thinking else { return }
      if let reply, self.speakerOn { self.play(reply) } else { self.listen() }
    }
  }
  private func play(_ url: URL) {
    guard let sound = try? AVAudioPlayer(contentsOf: url) else { listen(); return }
    sound.delegate = self; sound.isMeteringEnabled = true
    // The speed that the person chose in Settings. The pitch stays.
    sound.enableRate = true
    sound.rate = Float(PanelPreferences.voiceRate(UserDefaults.standard.object(forKey: PanelPreferences.Key.voiceRate)))
    player = sound; phase = .speaking
    sound.play()
    meterTimer?.invalidate()
    meterTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30, repeats: true) { [weak self] _ in
      guard let self, let player = self.player else { return }
      player.updateMeters()
      self.meter.feed(rms: pow(10, Double(player.averagePower(forChannel: 0)) / 20))
    }
  }
  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    meterTimer?.invalidate(); meterTimer = nil
    self.player = nil
    if phase == .speaking { listen() }
  }
}

/// The microphone's gate behind a lock: the main thread mutes and unmutes, the audio thread asks for each buffer.
/// `MicrophoneGate` holds the rule.
final class MicrophoneLatch: Sendable {
  private let gate = OSAllocatedUnfairLock(initialState: MicrophoneGate())
  /// The person turned the microphone on or off now.
  func set(on: Bool) {
    let now = AVAudioTime.seconds(forHostTime: mach_absolute_time())
    gate.withLock { on ? $0.unmute(at: now) : $0.mute(at: now) }
  }
  /// The buffer that the engine stamped with `when` and that lasts `seconds` may go into the recording.
  func admits(_ when: AVAudioTime, seconds: Double) -> Bool {
    guard when.isHostTimeValid else { return gate.withLock { $0.admitsUntimed } }
    let start = AVAudioTime.seconds(forHostTime: when.hostTime)
    return gate.withLock { $0.admits(start: start, seconds: seconds) }
  }
}
