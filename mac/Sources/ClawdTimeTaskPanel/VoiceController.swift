import AVFoundation
import AppKit
import TaskPanelCore

/// One spoken conversation with ClawdTime: listen for a sentence, send it, play
/// the answer, listen again. It never listens while it speaks.
final class VoiceController: NSObject, AVAudioPlayerDelegate {
  enum Phase: Equatable { case off, listening, thinking, speaking }
  private(set) var phase = Phase.off { didSet { if phase != oldValue { onChange?() } } }
  var micOn = true { didSet { onChange?() } }
  var speakerOn = true {
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
    let out = file
    input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
      var sum: Float = 0
      let count = Int(buffer.frameLength)
      if let samples = buffer.floatChannelData, count > 0 {
        for index in 0..<count { let value = samples[0][index]; sum += value * value }
        sum = (sum / Float(count)).squareRoot()
      }
      try? out?.write(from: buffer)
      let seconds = Double(count) / rate
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
