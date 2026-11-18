// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "ClawdTimeCompanion", platforms: [.macOS(.v14)], products: [
    .executable(name: "ClawdTimeCompanion", targets: ["ClawdTimeCompanion"]),
    .executable(name: "ClawdTimeTaskCapture", targets: ["ClawdTimeTaskCapture"]),
    .library(name: "DeviceCore", targets: ["DeviceCore"]),
    .executable(name: "ClawdTimeTaskPanel", targets: ["ClawdTimeTaskPanel"]),
], targets: [
    .target(name: "DeviceCore"),
    .target(name: "TaskPanelCore"),
    .executableTarget(name: "ClawdTimeTaskPanel", dependencies: ["TaskPanelCore"], resources: [.copy("Resources/Mascot.png")]),
    .testTarget(name: "TaskPanelCoreTests", dependencies: ["TaskPanelCore"]),
    .executableTarget(name: "ClawdTimeCompanion", dependencies: ["DeviceCore"]),
    .executableTarget(name: "ClawdTimeTaskCapture", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
], swiftLanguageModes: [.v5])
