/// Explicit development capture bounds. These options never affect live leases.
public struct CameraProbeLimits {
  public let seconds: Int
  public var maxFrames: Int { seconds * 4 }
  public var processDeadlineSeconds: Int { seconds + 5 }

  public init(arguments: [String]) throws {
    let positions = arguments.indices.filter { arguments[$0] == "--probe-seconds" }
    guard positions.count <= 1 else { throw HelperError(400, "Specify probe duration once.") }
    guard let index = positions.first else { seconds = 30; return }
    guard arguments.contains("--camera-probe"), index + 1 < arguments.count,
      let value = Int(arguments[index + 1]), String(value) == arguments[index + 1],
      (1...120).contains(value) else {
      throw HelperError(400, "--probe-seconds requires an integer from 1 through 120 in camera-probe mode.")
    }
    seconds = value
  }
}
