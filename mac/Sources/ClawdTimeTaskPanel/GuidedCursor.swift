import AppKit
import QuartzCore
import TaskPanelCore

/// The live cursor of computer use. Before the hands click, scroll, drag or
/// type, this cursor glides to the place, with a short label of what they do
/// there. Only then does the real event go, so a person sees each action before
/// it happens: at the Mac, and on a phone that shows the screen. The cursor is
/// ClawdTime's own: a small orange arrow with three short rays at its tip. The
/// tip is the place: the hot spot of the arrow is exactly where the hands act.
/// The pointer of the Mac stays the person's. When the hands bring it to the
/// place for a click, its tip meets the tip of the arrow.
///
/// Its window is above every other window, shows on every Space and lets
/// every click through: `GuidedOverlay.cursor` holds that rule. A screen share
/// shows it. The picture that the worker takes leaves it out, as it leaves out
/// every window of ClawdTime. With Reduce Motion the cursor jumps and nothing
/// glides. All points here are screen points counted from the bottom left, as
/// windows are.
///
/// It has two paces. The fast one is brisk. The calm one, for a recording or a
/// call that shows the screen, glides for about half a second, leaves a short
/// trail that fades, and opens a ring at a click. The trail has a window of its
/// own over the main display, made at the first calm glide and shown only
/// while one runs.
@MainActor final class GuidedCursor {
  private let pet: PetController
  let window: PetWindow
  private let view = GuidedCursorView(frame: .zero)
  private let clock = FrameClock()
  private var path: GuidedPath?
  private var elapsed = 0.0
  private var shown: CGPoint?
  private var label = ""
  private var pillWidth = 0.0
  private var shownLayout: GuidedLayout?
  private var fade: Task<Void, Never>?
  /// Reduce Motion, as it was when the cursor last set out.
  private var still = false
  /// The pace of the last glide. A click takes the pulse of that pace.
  private var pace = CursorPace.fast
  /// The window of the trail, under the cursor. Nil until the first calm glide.
  private var trailWindow: PetWindow?
  private let trailView = GuidedTrailView(frame: .zero)

  init(pet: PetController) {
    self.pet = pet
    let rule = GuidedOverlay.cursor
    let side = CGFloat(GuidedLayout.reach * 2)
    window = PetWindow.make(size: NSSize(width: side, height: side))
    window.contentView = view
    window.ignoresMouseEvents = rule.ignoresMouseEvents
    // A screen share and a recording show the cursor. The worker's own picture does not.
    window.sharingType = rule.inScreenShare ? .readOnly : .none
    // Above the menu bar, an open menu and every app, as the real pointer is.
    window.level = NSWindow.Level(rawValue: rule.level)
    var spaces: NSWindow.CollectionBehavior = [.stationary, .ignoresCycle]
    if rule.onEverySpace { spaces.insert(.canJoinAllSpaces) }
    if rule.besideFullScreenApps { spaces.insert(.fullScreenAuxiliary) }
    window.collectionBehavior = spaces
    clock.onFrame = { [weak self] step in self?.frame(step) }
  }

  /// Where the tip is now, while the cursor is on the screen.
  var place: CGPoint? { window.isVisible ? shown : nil }
  /// The windows of the cursor: a screen share shows them, the worker's picture never does.
  func isOverlay(_ other: NSWindow) -> Bool { other === window || other === trailWindow }
  /// Geometry only: label text stays in this process and never enters metadata.
  func presentationBounds(at target: CGPoint, label text: String) -> CGRect {
    GuidedLayout(tip: target, pillWidth: GuidedCursorView.pillWidth(for: GuidedLook.label(text)), screen: screen)
      .paintedBounds.intersection(screen)
  }
  /// The parts actually drawn now, rather than the transparent overlay window.
  /// Read afresh by typing heartbeats; moving/fading overlays are not cached in
  /// presentation state. Account for a window repositioned by the window server.
  var visiblePresentationBounds: CGRect? {
    guard window.isVisible, window.alphaValue > 0, let layout = shownLayout else { return nil }
    let bounds = layout.paintedBounds.offsetBy(dx: window.frame.minX - layout.window.minX,
      dy: window.frame.minY - layout.window.minY).intersection(screen)
    return bounds.isNull || bounds.isEmpty ? nil : bounds
  }
  /// The main display: the one that the hands use.
  private var screen: CGRect { (NSScreen.screens.first ?? NSScreen.main)?.frame ?? CGRect(x: 0, y: 0, width: 1440, height: 900) }

  /// The size that the window was last given. While it stays, only the place of the window changes.
  private var size = CGSize.zero
  private func put(_ tip: CGPoint) {
    shown = tip
    let layout = GuidedLayout(tip: tip, pillWidth: pillWidth, screen: screen)
    shownLayout = layout
    if size == layout.window.size { window.setFrameOrigin(layout.window.origin) }
    else { size = layout.window.size; window.setFrame(layout.window, display: false) }
    view.show(layout, label: label)
  }
  private func frame(_ step: Double) {
    guard let path else { return }
    elapsed += step
    put(path.point(at: elapsed))
    if pace == .calm, let trail = trailWindow {
      trailView.show(GuidedTrail.marks(on: path, at: elapsed, pace: pace, still: still), origin: trail.frame.origin)
    }
  }
  /// The window of the trail over the main display, made the first time. It is under the cursor and lets
  /// every click through, as the cursor does.
  private func showTrail() {
    let trail = trailWindow ?? {
      let rule = GuidedOverlay.cursor
      let made = PetWindow.make(size: screen.size)
      made.contentView = trailView
      made.ignoresMouseEvents = rule.ignoresMouseEvents
      made.sharingType = rule.inScreenShare ? .readOnly : .none
      made.level = NSWindow.Level(rawValue: rule.level - 1)
      var spaces: NSWindow.CollectionBehavior = [.stationary, .ignoresCycle]
      if rule.onEverySpace { spaces.insert(.canJoinAllSpaces) }
      if rule.besideFullScreenApps { spaces.insert(.fullScreenAuxiliary) }
      made.collectionBehavior = spaces
      trailWindow = made
      return made
    }()
    if trail.frame != screen { trail.setFrame(screen, display: false) }
    trailView.clear()
    trail.orderFrontRegardless()
  }
  private func endTrail() {
    // The fast pace never made the window: nothing to do.
    guard let trailWindow else { return }
    trailView.clear()
    if trailWindow.isVisible { trailWindow.orderOut(nil) }
  }
  private func pause(_ seconds: Double) async {
    try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
  }

  /// Sends the cursor to `target` with the label of the command, and returns
  /// when it is there and the person had a moment to read it. While it is on
  /// the screen it goes on from where it is; else it comes out of the mascot.
  /// With Reduce Motion there is no glide: the cursor is at the target at once.
  /// `pace` is fast, or calm for a recording or a call.
  /// It returns the seconds that it took, for the timing of the step.
  @discardableResult func travel(to target: CGPoint, label text: String, pace: CursorPace = .fast) async -> Double {
    let began = Date()
    fade?.cancel(); fade = nil
    still = Theme.reduceMotion
    self.pace = pace
    let shownBefore = place
    let way = GuidedPath.glide(from: GuidedPath.origin(shown: shownBefore, mascot: pet.handsOrigin, pointer: NSEvent.mouseLocation),
                               to: target, still: still, pace: pace)
    pet.point(at: target)
    let said = GuidedLook.label(text)
    // The same words at the same place: the person has read them already.
    let relabeled = shownBefore == nil || said != label
    label = said; pillWidth = GuidedCursorView.pillWidth(for: label)
    elapsed = 0; path = way
    put(way.point(at: 0))
    // A fade that still runs ends here.
    NSAnimationContext.runAnimationGroup({ context in context.duration = 0; window.animator().alphaValue = 1 }, completionHandler: nil)
    window.alphaValue = 1
    // In front of every window, with no focus taken: the window can never be key or main.
    window.orderFrontRegardless()
    // The clock moves the cursor on its way. At the place nothing moves, so the clock stops.
    if way.duration > 0 {
      // A trail only at the calm pace. The fast pace makes no window for it.
      if pace == .calm && !still { showTrail() }
      clock.framesPerSecond = 120
      clock.start(on: view)
      await pause(way.duration)
    }
    path = nil
    clock.stop()
    endTrail()
    put(target)
    await pause(GuidedPath.dwell(still: still, moved: way.length >= GuidedPath.inPlace, relabeled: relabeled))
    return Date().timeIntervalSince(began)
  }
  /// The hands click where the cursor is. They brought the pointer of the Mac here for it. The rays pulse
  /// once; with Reduce Motion nothing moves.
  func pulse() {
    guard window.isVisible else { return }
    view.pulse(still: still, pace: pace)
  }
  /// The command is done: the mascot stands straight, and the cursor fades unless another command sends it on.
  func rest() {
    pet.point(at: nil)
    guard window.isVisible, fade == nil else { return }
    fade = Task { [weak self] in
      try? await Task.sleep(nanoseconds: UInt64(GuidedPath.rest * 1_000_000_000))
      guard let self, !Task.isCancelled else { return }
      if !Theme.reduceMotion {
        NSAnimationContext.runAnimationGroup({ context in context.duration = 0.18; self.window.animator().alphaValue = 0 }, completionHandler: nil)
        try? await Task.sleep(nanoseconds: 200_000_000)
        // Another command sent it out again while it faded.
        guard !Task.isCancelled else { return }
      }
      self.fade = nil
      self.out()
    }
  }
  /// The cursor leaves the screen: nothing of it moves or looks any more.
  private func out() {
    clock.stop()
    endTrail()
    if window.isVisible { window.orderOut(nil) }
  }
  /// The run is over, or it was stopped: nothing points any more.
  func hide() {
    fade?.cancel(); fade = nil
    path = nil
    pet.point(at: nil)
    out()
  }
  /// The hands type, or stop typing: the mascot shows it.
  func typing(_ on: Bool) { pet.setTyping(on) }
}
