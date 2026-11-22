import AppKit
import CoreGraphics
import DeviceCore

@MainActor func captureDisplayConfiguration() -> DisplayConfigurationSignature? {
  func list(active: Bool) -> [CGDirectDisplayID]? {
    var count: UInt32 = 0
    let first = active ? CGGetActiveDisplayList(0, nil, &count) : CGGetOnlineDisplayList(0, nil, &count)
    guard first == .success, count > 0, count <= 32 else { return nil }
    let capacity = count
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(capacity))
    let second = active ? CGGetActiveDisplayList(capacity, &ids, &count) : CGGetOnlineDisplayList(capacity, &ids, &count)
    guard second == .success, count > 0, count <= capacity else { return nil }
    return Array(ids.prefix(Int(count)))
  }
  guard let active = list(active: true), let online = list(active: false) else { return nil }
  let screens = NSScreen.screens
  let screenIDs = screens.compactMap { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
  guard !screens.isEmpty, screenIDs.count == screens.count, Set(screenIDs).count == screenIDs.count,
    Set(screenIDs).isSubset(of: Set(online)) else { return nil }
  var entries: [DisplayConfigurationEntry] = []
  for id in online {
    guard CGDisplayIsOnline(id) != 0, let mode = CGDisplayCopyDisplayMode(id) else { return nil }
    let bounds = CGDisplayBounds(id)
    let matching = screens.filter {
      ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == id
    }
    guard matching.count <= 1 else { return nil }
    entries.append(DisplayConfigurationEntry(id: id, active: CGDisplayIsActive(id) != 0,
      main: CGDisplayIsMain(id) != 0, x: bounds.origin.x, y: bounds.origin.y, width: bounds.width, height: bounds.height,
      modeID: UInt32(bitPattern: mode.ioDisplayModeID), modeFlags: mode.ioFlags, modeWidth: mode.width, modeHeight: mode.height,
      pixelWidth: mode.pixelWidth, pixelHeight: mode.pixelHeight, refreshRate: mode.refreshRate,
      rotation: CGDisplayRotation(id), mirrorOf: CGDisplayMirrorsDisplay(id), inMirrorSet: CGDisplayIsInMirrorSet(id) != 0,
      backingScale: matching.first.map { Double($0.backingScaleFactor) }))
  }
  // Reject topology changes mid-read, even when enumeration truncated cleanly.
  guard list(active: true)?.sorted() == active.sorted(), list(active: false)?.sorted() == online.sorted() else { return nil }
  return DisplayConfigurationSignature(activeIDs: active, displays: entries)
}
