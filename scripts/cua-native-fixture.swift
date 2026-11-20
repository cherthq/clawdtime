// Disposable native qualification surface. Contains synthetic task data only.
// Run two separately bundled instances with: --name Alpha|Beta --state PRIVATE_FILE.
import AppKit
import Darwin

final class Fixture: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  var entry: NSTextField!
  var result: NSTextField!
  var backdrop: NSWindow?
  let name: String
  let state: URL
  init(name: String, state: URL) { self.name = name; self.state = state }
  func applicationDidFinishLaunching(_ notification: Notification) {
    NSApp.setActivationPolicy(.regular)
    let menu = NSMenu()
    let appMenu = NSMenuItem(); menu.addItem(appMenu)
    let submenu = NSMenu(); appMenu.submenu = submenu
    submenu.addItem(withTitle: "Quit fixture", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    NSApp.mainMenu = menu
    let frame = NSScreen.screens[0].visibleFrame
    if name == "Alpha" {
      let background = NSWindow(contentRect:NSScreen.screens[0].frame,styleMask:.borderless,backing:.buffered,defer:false)
      background.backgroundColor = .white
      background.isReleasedWhenClosed = false
      background.orderFront(nil)
      backdrop = background
    }
    let width = min(620, (frame.width - 80) / 2)
    let left = frame.minX + (name == "Alpha" ? 20 : frame.width - width - 20)
    window = NSWindow(contentRect: NSRect(x:left,y:frame.minY+160,width:width,height:520),styleMask:[.titled,.closable,.miniaturizable],backing:.buffered,defer:false)
    window.title = "ClawdTime Native Fixture " + name
    window.isReleasedWhenClosed = false
    let content = window.contentView!
    func label(_ text: String, y: Double, size: Double) -> NSTextField {
      let v = NSTextField(wrappingLabelWithString:text)
      v.font = .systemFont(ofSize:size,weight:.medium)
      v.frame = NSRect(x:30,y:y,width:width-60,height:70)
      content.addSubview(v); return v
    }
    _ = label("Native fixture " + name,y:420,size:32)
    _ = label("Disposable local test. Enter the requested note and save it.",y:335,size:22)
    entry = NSTextField(frame:NSRect(x:30,y:255,width:width-60,height:52))
    entry.font = .systemFont(ofSize:26)
    entry.placeholderString = name + " note"
    entry.setAccessibilityLabel(name + " note")
    content.addSubview(entry)
    let save = NSButton(title:"Save " + name,target:self,action:#selector(saveNote))
    save.bezelStyle = .rounded; save.font = .systemFont(ofSize:24)
    save.frame = NSRect(x:30,y:170,width:230,height:56)
    content.addSubview(save)
    result = label("No note saved",y:50,size:26)
    persist("")
    window.makeKeyAndOrderFront(nil)
    window.setFrameOrigin(NSPoint(x:left,y:frame.minY+160))
    NSApp.activate(ignoringOtherApps:true)
  }
  func persist(_ value: String) {
    let data = try! JSONSerialization.data(withJSONObject:["fixture":name,"saved":value])
    try! data.write(to:state,options:.atomic)
    try! FileManager.default.setAttributes([.posixPermissions:0o600],ofItemAtPath:state.path)
  }
  @objc func saveNote() {
    window.makeFirstResponder(nil)
    result.stringValue = "Saved " + name + ": " + entry.stringValue
    persist(entry.stringValue)
  }
}
umask(0o077)
let arguments = CommandLine.arguments
func value(_ flag: String) -> String { guard let i = arguments.firstIndex(of:flag), i+1 < arguments.count else { fatalError("Missing fixture argument") }; return arguments[i+1] }
let name = value("--name"), path = value("--state")
guard ["Alpha","Beta"].contains(name), path.hasPrefix("/") else { fatalError("Invalid fixture argument") }
let fixture = Fixture(name:name,state:URL(fileURLWithPath:path))
NSApplication.shared.delegate = fixture
NSApplication.shared.run()
