import AppKit
import ClawdTimeAppCore
import Foundation

/// `ClawdTime --self-test [--runtime PATH]` checks the runtime and the engine
/// handshake with no window, prints one JSON line and exits 0 when it passes.
/// Without arguments the app opens.
let arguments = Array(CommandLine.arguments.dropFirst())
signal(SIGPIPE, SIG_IGN)

func runtimeArgument(_ arguments: [String]) -> URL? {
  guard let index = arguments.firstIndex(of: "--runtime"), arguments.indices.contains(index + 1) else { return nil }
  return URL(fileURLWithPath: arguments[index + 1], isDirectory: true)
}

if arguments.contains("--self-test") {
  guard let runtime = runtimeArgument(arguments) ?? RuntimeLayout.bundled() else {
    print(#"{"ok":false,"problem":"No runtime folder."}"#)
    exit(1)
  }
  let report = SelfTest.run(runtime: runtime)
  print(report.json())
  exit(report.ok ? 0 : 1)
}

MainActor.assumeIsolated {
  let application = NSApplication.shared
  let delegate = AppDelegate(runtimeOverride: runtimeArgument(arguments))
  application.delegate = delegate
  application.run()
}
