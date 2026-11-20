import AppKit
import SceneKit
import TaskPanelCore

/// Flint: not drawn yet. A plain ball stands in.
final class FlintScene: MascotFigure {
  let scene = SCNScene()
  let camera = Stage.camera()
  private let body = SCNNode(geometry: SCNSphere(radius: 1.1))
  init() {
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = MascotScene.studio()
    body.geometry?.firstMaterial = Finish.solid(0xF2EFE8, roughness: 0.3)
    scene.rootNode.addChildNode(body); scene.rootNode.addChildNode(camera)
  }
  func set(mood: MascotMood) {}
  func apply(_ pose: MascotPose) {
    body.position = SCNVector3(0, pose.bob + pose.lift, 0)
    body.scale = SCNVector3(pose.scale, pose.scale * pose.squash, pose.scale)
  }
}
