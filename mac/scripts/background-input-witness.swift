// Read-only qualification witness. Never reads clipboard contents, keys, titles,
// screenshots, accessibility trees, or user documents; never submits input.
import AppKit
import Foundation

let frontmost = NSWorkspace.shared.frontmostApplication
let pointer = NSEvent.mouseLocation
let report: [String: Any] = [
    "version": 1,
    "observedAt": ISO8601DateFormatter().string(from: Date()),
    "monotonicNanoseconds": String(DispatchTime.now().uptimeNanoseconds),
    "frontmost": [
        "pid": frontmost.map { Int($0.processIdentifier) } as Any? ?? NSNull(),
        "bundleId": frontmost?.bundleIdentifier as Any? ?? NSNull(),
    ],
    "pointer": [
        "x": pointer.x,
        "y": pointer.y,
        "coordinates": "AppKit global points (bottom-left origin)",
    ],
    "clipboardChangeCount": NSPasteboard.general.changeCount,
    "limits": [
        "A matching pre/post pointer cannot exclude motion that was later restored.",
        "A matching frontmost app cannot exclude brief activation between samples.",
        "This witness does not observe physical typing or prove it was not redirected.",
    ],
]
let encoded = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])
FileHandle.standardOutput.write(encoded)
FileHandle.standardOutput.write(Data([0x0a]))
