import AppKit
import ApplicationServices
import TaskPanelCore

/// Live video hints from the native hands. One POST can be in flight and only
/// the newest unsent event is retained; a slow video consumer cannot delay input.
/// Nothing here observes pixels, changes the desktop, or writes diagnostics.
@MainActor final class HandsPresentation {
  private var client: PanelClient?
  private var producerId = UUID().uuidString
  private var sequence = 0
  private var commandSeq = 0
  private var surfaceGate = CallPresentationSurfaceGate()
  private var intent = CallPresentationIntent()
  private var heartbeat: Task<Void, Never>?
  private var settlement: Task<Void, Never>?
  private var sender: Task<Void, Never>?
  private var pending: CallPresentationEvent?
  private var active = false
  private var allowed: (() -> Bool)?
  private var overlayBounds: (() -> CGRect?)?

  func connect(_ client: PanelClient, overlayBounds: @escaping () -> CGRect?, allowed: @escaping () -> Bool) {
    self.client = client; self.overlayBounds = overlayBounds; self.allowed = allowed
  }
  func begin(_ seq: Int) {
    if commandSeq != seq { cancelSettlement(); intent.beginCommand() }
    commandSeq = seq
    active = true
    if heartbeat == nil {
      heartbeat = Task { [weak self] in
        while !Task.isCancelled {
          guard let self else { return }
          try? await Task.sleep(nanoseconds: 350_000_000)
          if Task.isCancelled { return }
          await self.refresh()
        }
      }
    }
  }

  /// A desktop-switching implementation calls this before activation. A later
  /// independently observed surface establishes the new context; the old target
  /// is never reused. This seam does not implement or assume Space switching.
  func transition() {
    cancelSettlement()
    intent.retire(); surfaceGate.reset()
    enqueue(.transition)
  }

  func point(_ rect: CGRect) { publish(.target, target: rect) }
  var currentSurface: CallPresentationEvent.Surface? { Self.surface() }
  func type(in field: CGRect?, overlay: CGRect, observedSurface: CallPresentationEvent.Surface?) {
    intent.beginTyping()
    guard let observedSurface, observedSurface == Self.surface() else { invalidateGeometry(); return }
    guard let field else { enqueue(.reset); return }
    publish(.typing, target: field.union(overlay))
  }
  func endTyping() { intent.endTyping() }

  func reset() {
    cancelSettlement()
    active = false; intent.retire(); surfaceGate.reset()
    heartbeat?.cancel(); heartbeat = nil
    // Supersede queued targets, including after Stop. An in-flight event has a
    // bounded lifetime and the following higher sequence retires it.
    enqueue(.reset)
  }

  private func refresh() async {
    guard active, allowed?() == true else { reset(); return }
    if intent.typing {
      let readingCommand = commandSeq
      let before = Self.surface()
      // Accessibility work never blocks the panel's UI/Stop button. No field
      // content is requested, and secure fields do not produce a target.
      let field = await Task.detached(priority: .utility) {
        HandsTree.focusIsSecure() == false ? HandsTree.focusFrame() : nil
      }.value
      guard active, !Task.isCancelled, allowed?() == true, intent.typing, commandSeq == readingCommand else { return }
      guard before == Self.surface() else { invalidateGeometry(); return }
      guard let field else { enqueue(.reset); return }
      publish(.typing, target: field.union(overlayBounds?() ?? .null))
    } else {
      publish(.context)
    }
  }

  /// Geometry loss retires coordinates but not an in-progress typing command.
  /// Its next heartbeat must independently reacquire a nonsecure focus field.
  private func invalidateGeometry() {
    cancelSettlement()
    intent.geometryChanged(); surfaceGate.reset(); enqueue(.transition)
  }

  private func cancelSettlement() { settlement?.cancel(); settlement = nil }

  /// A short independent geometry observation allows a first click to be framed
  /// during the existing cursor glide, even when that command ends before the
  /// regular heartbeat. This adds no wait to input and never repeats an action.
  private func settleTarget() {
    cancelSettlement()
    let observedCommand = commandSeq
    settlement = Task { [weak self] in
      try? await Task.sleep(nanoseconds: 80_000_000)
      guard let self, !Task.isCancelled, self.commandSeq == observedCommand, self.active else { return }
      self.settlement = nil
      self.publish(.context)
    }
  }

  private func publish(_ kind: CallPresentationEvent.Kind, target: CGRect? = nil) {
    guard active, allowed?() == true else { reset(); return }
    guard let surface = Self.surface() else { cancelSettlement(); surfaceGate.reset(); intent.geometryChanged(); enqueue(.reset); return }
    let clipped = target.map { $0.intersection(surface.bounds) }
    if let clipped, clipped.isNull || clipped.isEmpty { enqueue(.reset); return }
    guard surfaceGate.observe(surface) else {
      cancelSettlement()
      intent.geometryChanged()
      // The action is new on this surface. After widening, a short-lived intent
      // may be admitted only if the same command and geometry are still current.
      if kind == .target, let clipped {
        intent.deferTarget(.init(clipped), on: surface, commandSeq: commandSeq, at: Date().timeIntervalSince1970 * 1000)
        settleTarget()
      }
      enqueue(.transition)
      return
    }
    if kind == .context, let target = intent.takeTarget(on: surface, commandSeq: commandSeq, now: Date().timeIntervalSince1970 * 1000) {
      enqueue(.target, surface: surface, target: target)
      return
    }
    enqueue(kind, surface: surface, target: clipped.map(CallPresentationEvent.Rect.init))
  }

  private func enqueue(_ kind: CallPresentationEvent.Kind, surface: CallPresentationEvent.Surface? = nil,
                       target: CallPresentationEvent.Rect? = nil) {
    guard commandSeq > 0, let client else { return }
    sequence += 1
    let event = CallPresentationEvent(producerId: producerId, sequence: sequence, commandSeq: commandSeq,
      at: Date().timeIntervalSince1970 * 1000, kind: kind, reducedMotion: Theme.reduceMotion, surface: surface, target: target)
    guard (try? event.validate()) != nil else { return }
    pending = event
    guard sender == nil else { return }
    sender = Task { [weak self] in
      guard let self else { return }
      defer { self.sender = nil }
      while let event = self.pending {
        self.pending = nil
        if event.expiresAt <= Date().timeIntervalSince1970 * 1000 { continue }
        // This is a best-effort hint, never an input receipt or a UI success.
        // No retry: a fresh heartbeat replaces a lost event.
        try? await client.handsPresentation(event)
      }
    }
  }

  /// The public, on-screen window list identifies the front app's foremost
  /// ordinary window without reading its title. Windows outside the main
  /// display cannot establish the presentation surface.
  private static func surface() -> CallPresentationEvent.Surface? {
    guard let display = HandsDisplay.main,
      let app = NSWorkspace.shared.frontmostApplication,
      app.processIdentifier != getpid(), let appId = app.bundleIdentifier,
      let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    let bounds = CGRect(x: 0, y: 0, width: display.map.width, height: display.map.height)
    for window in windows {
      guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == app.processIdentifier,
        (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
        let id = window[kCGWindowNumber as String] as? NSNumber,
        let raw = window[kCGWindowBounds as String] as? [String: Any],
        let rect = CGRect(dictionaryRepresentation: raw as CFDictionary) else { continue }
      let visible = rect.intersection(bounds)
      guard !visible.isNull, visible.width >= 20, visible.height >= 20 else { continue }
      return .init(displayId: String(display.id), width: display.map.width, height: display.map.height, scale: display.map.scale,
        appId: appId, windowId: id.stringValue, window: .init(visible))
    }
    return nil
  }
}
