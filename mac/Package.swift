// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "ClawdTimeCompanion", platforms: [.macOS(.v14)], products: [
    .executable(name: "ClawdTimeCompanion", targets: ["ClawdTimeCompanion"]),
    .library(name: "DeviceCore", targets: ["DeviceCore"]),
], targets: [
    .target(name: "DeviceCore"),
    .executableTarget(name: "ClawdTimeCompanion", dependencies: ["DeviceCore"]),
    .testTarget(name: "DeviceCoreTests", dependencies: ["DeviceCore"]),
], swiftLanguageModes: [.v5])
