// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "ClawdTimeCompanion", platforms: [.macOS(.v14)], products: [
    .executable(name: "ClawdTimeCompanion", targets: ["ClawdTimeCompanion"]),
    .executable(name: "ClawdTimeTaskCapture", targets: ["ClawdTimeTaskCapture"]),
    .library(name: "DeviceCore", targets: ["DeviceCore"]),
    .executable(name: "ClawdTimeTaskPanel", targets: ["ClawdTimeTaskPanel"]),
    .executable(name: "ClawdTimeReviewWindow", targets: ["ClawdTimeReviewWindow"]),
    .executable(name: "PanelPreview", targets: ["PanelPreview"]),
], targets: [
    .target(name: "DeviceCore"),
    .target(name: "TaskPanelCore"),
    .executableTarget(name: "ClawdTimeReviewWindow", dependencies: ["TaskPanelCore"]),
    // The panel is a bare executable. Its Info.plist is linked in, so macOS can
    // say why it asks for the microphone when the person talks to ClawdTime.
    .executableTarget(name: "ClawdTimeTaskPanel", dependencies: ["TaskPanelCore"], exclude: ["Info.plist"],
        resources: [.copy("Resources/Fonts")],
        linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist",
            "-Xlinker", "\(Context.packageDirectory)/Sources/ClawdTimeTaskPanel/Info.plist"])]),
    .testTarget(name: "TaskPanelCoreTests", dependencies: ["TaskPanelCore"]),
    // The views of the panel, built off screen: no window is shown and nothing is clicked on the screen.
    .testTarget(name: "TaskPanelViewTests", dependencies: ["ClawdTimeTaskPanel", "TaskPanelCore"]),
    .executableTarget(name: "ClawdTimeCompanion", dependencies: ["DeviceCore"]),
    .executableTarget(name: "ClawdTimeTaskCapture", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
    .executableTarget(name: "PanelPreview", dependencies: ["DeviceCore"]),
], swiftLanguageModes: [.v5])
