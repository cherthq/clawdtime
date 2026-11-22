import AppKit
import Foundation
import Darwin
import TaskPanelCore

private func readProtected(_ path: String) throws -> Data {
    guard path.hasPrefix("/") else { throw PreparedReviewDocument.ReviewError.invalid }
    var parent = stat()
    let parentPath = (path as NSString).deletingLastPathComponent
    guard lstat(parentPath, &parent) == 0, parent.st_mode & S_IFMT == S_IFDIR,
          parent.st_uid == getuid(), parent.st_mode & 0o077 == 0 else { throw PreparedReviewDocument.ReviewError.invalid }
    let fd = open(path, O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { throw PreparedReviewDocument.ReviewError.invalid }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
          info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 32768 else { throw PreparedReviewDocument.ReviewError.invalid }
    let file = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
    let data = try file.readToEnd() ?? Data()
    guard data.count == info.st_size else { throw PreparedReviewDocument.ReviewError.invalid }
    return data
}

@MainActor final class ReviewWindowDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let document: PreparedReviewDocument
    var window: NSWindow?
    var expiry: Timer?
    var textView: NSTextView?
    init(document: PreparedReviewDocument) { self.document = document }
    func applicationDidFinishLaunching(_ notification: Notification) {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1080, height: 760),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.title = document.title
        panel.delegate = self
        panel.isReleasedWhenClosed = false
        panel.sharingType = .readOnly
        panel.collectionBehavior = [.moveToActiveSpace]
        let root = NSView(frame: panel.contentView!.bounds)
        root.autoresizingMask = [.width, .height]
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 66, width: 1032, height: 670))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        let text = NSTextView(frame: scroll.bounds)
        text.isEditable = false
        text.isSelectable = false
        text.isRichText = false
        text.isAutomaticLinkDetectionEnabled = false
        text.isAutomaticDataDetectionEnabled = false
        text.drawsBackground = false
        text.textContainerInset = NSSize(width: 16, height: 16)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        let content = NSMutableAttributedString()
        for section in document.sections {
            content.append(NSAttributedString(string: section.heading + "\n", attributes: [.font: NSFont.boldSystemFont(ofSize: 26), .foregroundColor: NSColor.labelColor]))
            content.append(NSAttributedString(string: section.text + "\n\n", attributes: [.font: NSFont.systemFont(ofSize: 21), .foregroundColor: NSColor.labelColor]))
        }
        text.textStorage?.setAttributedString(content)
        scroll.documentView = text
        textView = text
        root.addSubview(scroll)
        let stop = NSButton(title: "Stop sharing this review", target: self, action: #selector(stopReview))
        stop.frame = NSRect(x: 24, y: 16, width: 260, height: 36)
        root.addSubview(stop)
        panel.contentView = root
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        window = panel
        let ready: [String: Any] = ["ready": true, "appId": "com.clawdtime.review-view", "title": document.title, "windowId": String(panel.windowNumber), "pid": getpid()]
        if let bytes = try? JSONSerialization.data(withJSONObject: ready) {
            FileHandle.standardOutput.write(bytes + Data([10]))
        }
        expiry = Timer.scheduledTimer(withTimeInterval: max(0.01, (document.expiresAt - Date().timeIntervalSince1970 * 1000) / 1000), repeats: false) { _ in
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
        // The only command reduces authority: discard all old result claims.
        // No arbitrary content, screen selection, scripts or input are accepted.
        DispatchQueue.global().async {
            do {
                var line = Data()
                while let byte = try FileHandle.standardInput.read(upToCount: 1), !byte.isEmpty {
                    if byte.first == 10 {
                        let command = try PreparedReviewCommand.parse(line)
                        line = Data()
                        DispatchQueue.main.async { self.invalidate(command) }
                    } else {
                        line.append(byte)
                        if line.count > 1024 { throw PreparedReviewDocument.ReviewError.invalid }
                    }
                }
            } catch { }
            DispatchQueue.main.async { NSApplication.shared.terminate(nil) }
        }
    }
    func invalidate(_ command: PreparedReviewCommand) {
        textView?.textStorage?.setAttributedString(NSAttributedString(string: "Work changed.\n\nThe previous result is no longer current. Waiting for a fresh checked review.", attributes: [.font: NSFont.systemFont(ofSize: 26), .foregroundColor: NSColor.labelColor]))
        textView?.scrollRangeToVisible(NSRange(location: 0, length: 0))
        window?.contentView?.layoutSubtreeIfNeeded()
        window?.displayIfNeeded()
        if let bytes = try? JSONSerialization.data(withJSONObject: ["id": command.id, "invalidated": true] as [String: Any]) {
            FileHandle.standardOutput.write(bytes + Data([10]))
        }
    }
    @objc func stopReview() { NSApplication.shared.terminate(nil) }
    func windowWillClose(_ notification: Notification) { NSApplication.shared.terminate(nil) }
}

@main struct ReviewWindowMain {
    @MainActor static func main() {
        do {
            let args = CommandLine.arguments
            guard args.count == 3, args[1] == "--config" else { throw PreparedReviewDocument.ReviewError.invalid }
            let document = try PreparedReviewDocument.parse(readProtected(args[2]))
            let app = NSApplication.shared
            app.setActivationPolicy(.accessory)
            let delegate = ReviewWindowDelegate(document: document)
            app.delegate = delegate
            withExtendedLifetime(delegate) { app.run() }
        } catch {
            FileHandle.standardError.write(Data("Prepared review unavailable.\n".utf8))
            exit(1)
        }
    }
}
