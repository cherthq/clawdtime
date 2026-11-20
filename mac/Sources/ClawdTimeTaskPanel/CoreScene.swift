import AppKit
import SceneKit
import TaskPanelCore

/// The mascot as an instrument: a dark glass orb with an iris of light that tracks
/// the pointer, arcs that turn while agents work, and two fine rings in orbit.
/// It reads the same poses as the stone: a blink closes the iris, the state is
/// the color and the speed of the light.
final class CoreScene: MascotFigure {
  let scene = SCNScene()
  let camera = SCNNode()
  private let root = SCNNode()
  private let shell = SCNNode()
  private let look = SCNNode()
  private let iris = SCNNode()
  private let outerArcs = SCNNode(), innerArcs = SCNNode(), ticks = SCNNode(), rim = SCNNode()
  private let pupil = SCNNode(), pupilHalo = SCNNode()
  private let ringA = SCNNode(), ringB = SCNNode()
  private let spark = SCNNode(), sparkHalo = SCNNode()
  private let aura = SCNNode(), ping = SCNNode()
  private let glass = SCNMaterial()
  private let light = SCNMaterial(), faint = SCNMaterial(), bright = SCNMaterial()
  private let wire = SCNMaterial(), haloMaterial = SCNMaterial(), auraMaterial = SCNMaterial(), pingMaterial = SCNMaterial()
  private var mood = MascotMood.idle

  /// A flat band between two radii, from `start` over `sweep` degrees.
  private static func band(inner: CGFloat, outer: CGFloat, start: CGFloat, sweep: CGFloat) -> NSBezierPath {
    let path = NSBezierPath()
    path.appendArc(withCenter: .zero, radius: outer, startAngle: start, endAngle: start + sweep)
    path.appendArc(withCenter: .zero, radius: inner, startAngle: start + sweep, endAngle: start, clockwise: true)
    path.close()
    return path
  }
  private static func shape(_ paths: [NSBezierPath], _ material: SCNMaterial) -> SCNGeometry {
    let all = NSBezierPath()
    for path in paths { all.append(path) }
    all.flatness = 0.0015
    let shape = SCNShape(path: all, extrusionDepth: 0.004)
    shape.firstMaterial = material
    return shape
  }
  private static func glow(_ material: SCNMaterial) {
    material.lightingModel = .constant; material.isDoubleSided = true; material.writesToDepthBuffer = false
  }

  init() {
    scene.background.contents = NSColor.clear
    scene.lightingEnvironment.contents = MascotScene.studio()
    scene.lightingEnvironment.intensity = 1.25
    scene.rootNode.addChildNode(root)

    // The aura sits behind everything and carries the state as a soft light.
    Self.glow(auraMaterial); auraMaterial.diffuse.contents = MascotScene.halo(); auraMaterial.blendMode = .add
    aura.geometry = SCNPlane(width: 4.3, height: 4.3); aura.geometry?.firstMaterial = auraMaterial
    aura.position = SCNVector3(0, 0, -1.2)
    root.addChildNode(aura)

    glass.lightingModel = .physicallyBased
    glass.diffuse.contents = MascotScene.color(0x0B0D13)
    glass.roughness.contents = 0.10; glass.metalness.contents = 0.0
    glass.clearCoat.contents = 1.0; glass.clearCoatRoughness.contents = 0.04
    glass.emission.contents = MascotScene.sheenBand(); glass.emission.wrapT = .clampToBorder; glass.emission.intensity = 0
    let sphere = SCNSphere(radius: 1); sphere.segmentCount = 96; sphere.firstMaterial = glass
    shell.geometry = sphere
    root.addChildNode(shell)

    // The iris: flat bands of light on a plate just off the glass. It turns to look.
    for material in [light, faint, bright] { Self.glow(material) }
    rim.geometry = Self.shape([Self.band(inner: 0.515, outer: 0.535, start: 0, sweep: 180), Self.band(inner: 0.515, outer: 0.535, start: 180, sweep: 180)], light)
    outerArcs.geometry = Self.shape((0..<3).map { Self.band(inner: 0.385, outer: 0.445, start: CGFloat($0) * 120, sweep: 78) }, light)
    innerArcs.geometry = Self.shape((0..<2).map { Self.band(inner: 0.265, outer: 0.300, start: CGFloat($0) * 180 + 20, sweep: 128) }, light)
    ticks.geometry = Self.shape((0..<48).map { index in
      let long = index % 4 == 0
      return Self.band(inner: long ? 0.575 : 0.59, outer: 0.625, start: CGFloat(index) * 7.5 - 0.6, sweep: 1.2)
    }, faint)
    let disc = SCNSphere(radius: 0.125); disc.segmentCount = 40; disc.firstMaterial = bright
    pupil.geometry = disc; pupil.scale = SCNVector3(1, 1, 0.3)
    Self.glow(haloMaterial); haloMaterial.diffuse.contents = MascotScene.halo(); haloMaterial.blendMode = .add
    pupilHalo.geometry = SCNPlane(width: 0.95, height: 0.95); pupilHalo.geometry?.firstMaterial = haloMaterial
    pupilHalo.position = SCNVector3(0, 0, 0.01)
    for node in [ticks, rim, outerArcs, innerArcs, pupilHalo, pupil] { iris.addChildNode(node) }
    iris.position = SCNVector3(0, 0, 1.03)
    look.addChildNode(iris)
    shell.addChildNode(look)

    // A ring of light that leaves the orb when something waits for the person.
    Self.glow(pingMaterial)
    ping.geometry = Self.shape([Self.band(inner: 1.0, outer: 1.035, start: 0, sweep: 180), Self.band(inner: 1.0, outer: 1.035, start: 180, sweep: 180)], pingMaterial)
    ping.opacity = 0
    root.addChildNode(ping)

    // Two fine rings in orbit, as in a gyroscope. The spark rides the first.
    wire.lightingModel = .constant
    for (node, radius, pipe) in [(ringA, 1.46, 0.016), (ringB, 1.66, 0.012)] {
      let torus = SCNTorus(ringRadius: radius, pipeRadius: pipe)
      torus.ringSegmentCount = 160; torus.pipeSegmentCount = 12; torus.firstMaterial = wire
      let ring = SCNNode(geometry: torus)
      node.addChildNode(ring)
      root.addChildNode(node)
    }
    let bead = SCNSphere(radius: 0.085); bead.firstMaterial = bright
    spark.geometry = bead
    sparkHalo.geometry = SCNPlane(width: 0.9, height: 0.9); sparkHalo.geometry?.firstMaterial = haloMaterial
    sparkHalo.constraints = [SCNBillboardConstraint()]
    spark.addChildNode(sparkHalo)
    ringA.addChildNode(spark)

    let ambient = SCNNode(); ambient.light = SCNLight(); ambient.light?.type = .ambient
    ambient.light?.intensity = 120; ambient.light?.color = MascotScene.color(0xE8ECFF)
    let key = SCNNode(); key.light = SCNLight(); key.light?.type = .directional
    key.light?.intensity = 700; key.light?.color = MascotScene.color(0xFFF7EE); key.eulerAngles = SCNVector3(-0.8, -0.6, 0)
    // Light from behind on both sides draws the edge of a dark orb on a dark desk.
    let left = SCNNode(); left.light = SCNLight(); left.light?.type = .directional
    left.light?.intensity = 900; left.light?.color = MascotScene.color(0xBFD0FF); left.eulerAngles = SCNVector3(-0.1, -2.4, 0)
    let right = SCNNode(); right.light = SCNLight(); right.light?.type = .directional
    right.light?.intensity = 900; right.light?.color = MascotScene.color(0xFFD9B8); right.eulerAngles = SCNVector3(0.3, 2.4, 0)
    for node in [ambient, key, left, right] { scene.rootNode.addChildNode(node) }

    camera.camera = SCNCamera()
    camera.camera?.fieldOfView = 23; camera.camera?.zNear = 1; camera.camera?.zFar = 40
    camera.position = SCNVector3(0, 0.04, 11.4)
    scene.rootNode.addChildNode(camera)
    set(mood: .idle)
    apply(MascotPose())
  }

  /// The light carries the state: ember white at rest, blue at work, amber when it
  /// needs the person, red while the screen is shared.
  func set(mood: MascotMood) {
    self.mood = mood
    let tint: UInt32
    switch mood {
    case .idle, .sleepy: tint = 0xFFD9B0
    case .working: tint = 0x86A8FF
    case .attention: tint = 0xFFB936
    case .sharing: tint = 0xFF6257
    case .asleep, .offline: tint = 0x8A857D
    }
    let color = MascotScene.color(tint)
    light.diffuse.contents = color
    faint.diffuse.contents = color.withAlphaComponent(0.55)
    bright.diffuse.contents = color.blended(withFraction: 0.55, of: .white) ?? color
    // The rings take most of the state color, so they read on a light desk too.
    wire.diffuse.contents = (MascotScene.color(0xF4EFE6).blended(withFraction: 0.62, of: color) ?? color)
    haloMaterial.multiply.contents = color; auraMaterial.multiply.contents = color
    pingMaterial.diffuse.contents = color
  }

  func apply(_ pose: MascotPose) {
    root.position = SCNVector3(0, pose.bob + pose.lift, 0)
    // Glass does not squash like the stone: it only gives a little.
    let give = 1 + (pose.squash - 1) * 0.35
    let wide = 1 / sqrt(max(0.3, give))
    shell.scale = SCNVector3(pose.scale * wide, pose.scale * give, pose.scale * wide)
    shell.eulerAngles = SCNVector3(0, 0, pose.roll)

    // The iris looks where the eyes of the stone would look.
    look.eulerAngles = SCNVector3(-(pose.pupilY * 0.34) + pose.pitch * 0.6, pose.pupilX * 0.42 + pose.yaw * 0.6, 0)
    let open = max(0, min(1.3, pose.eyeOpen))
    let aperture = 0.30 + 0.70 * min(1, open) + 0.10 * max(0, open - 1)
    iris.scale = SCNVector3(aperture, aperture * (1 - 0.35 * pose.squint), 1)
    let lit = CGFloat(max(0.12, min(1, open * 1.4)))
    for node in [rim, outerArcs, innerArcs, ticks, pupil] { node.opacity = lit }
    outerArcs.eulerAngles.z = pose.sparkAngle
    innerArcs.eulerAngles.z = -pose.sparkAngle * 0.62
    ticks.eulerAngles.z = pose.sparkAngle * 0.08
    let glow = CGFloat(pose.glow)
    pupil.scale = SCNVector3(0.8 + 0.5 * glow, 0.8 + 0.5 * glow, 0.3)
    pupilHalo.opacity = lit * (0.35 + 0.65 * glow)

    ringA.scale = SCNVector3(pose.scale, pose.scale, pose.scale); ringB.scale = ringA.scale
    ringA.eulerAngles = SCNVector3(1.18 + pose.ringWobble, pose.sparkAngle * 0.5, -0.32 + pose.roll * 0.5)
    ringB.eulerAngles = SCNVector3(0.42 - pose.ringWobble, -pose.sparkAngle * 0.31, 0.9 + pose.roll * 0.5)
    spark.position = SCNVector3(1.46 * cos(pose.sparkAngle * 1.7), 0, 1.46 * sin(pose.sparkAngle * 1.7))
    spark.scale = SCNVector3(0.7 + 0.5 * glow, 0.7 + 0.5 * glow, 0.7 + 0.5 * glow)
    sparkHalo.opacity = 0.2 + 0.6 * glow
    aura.opacity = 0.10 + 0.34 * glow
    aura.scale = SCNVector3(pose.scale, pose.scale, 1)

    if mood == .attention {
      // One ring leaves the orb on each turn of the spark.
      let phase = CGFloat((pose.sparkAngle / (2 * .pi)).truncatingRemainder(dividingBy: 1))
      ping.scale = SCNVector3(1 + phase * 0.95, 1 + phase * 0.95, 1)
      ping.opacity = (1 - phase) * 0.7
    } else if ping.opacity != 0 { ping.opacity = 0 }

    if pose.sheen >= 0 {
      // The sheen of the mark is a scan line here.
      glass.emission.intensity = CGFloat(0.5 * sin(pose.sheen * .pi))
      glass.emission.contentsTransform = SCNMatrix4MakeTranslation(0, CGFloat(0.9 - pose.sheen * 1.8), 0)
    } else if glass.emission.intensity != 0 { glass.emission.intensity = 0 }
  }
}
