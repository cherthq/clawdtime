import CoreGraphics
import Foundation

/// How far one walk of the Accessibility tree may go. Each answer of another app is a message
/// between two processes, so the walk is the slow part of a look. It stops at the first limit
/// that it reaches.
public struct WalkLimits: Equatable, Sendable {
  /// Elements asked, levels under the window, and seconds.
  public let visits: Int, depth: Int, seconds: Double
  public init(visits: Int, depth: Int, seconds: Double) {
    self.visits = max(1, visits); self.depth = max(0, depth)
    self.seconds = seconds.isFinite ? max(0, seconds) : 0
  }
  /// A look at the screen. The parts of a window that do not show are left out, so these
  /// limits hold all of what a busy window shows. The limit of time holds an app that is slow
  /// to answer: the look then has the elements that came in time. The depth costs no time by
  /// itself, and the content of a web page lies deep, so it stays as it was.
  public static let look = WalkLimits(visits: 2000, depth: 60, seconds: 0.6)
}

/// Why a walk ended.
public enum WalkEnd: String, Equatable, Sendable {
  /// Every element that shows, down to the limit of depth, was asked.
  case whole
  /// The limit of elements was reached.
  case visits
  /// The time ran out.
  case time
}

/// What one element of the tree says, as the walk needs it.
public struct WalkVisit<Node> {
  /// The element to keep, or nil for one that has nothing to give (no role, no place).
  public var element: RawElement?
  /// Its frame in screen points from the top left, when the tree gives one.
  public var frame: CGRect?
  /// The elements under it, in the order of the tree.
  public var children: [Node]
  public init(element: RawElement?, frame: CGRect?, children: [Node]) {
    self.element = element; self.frame = frame; self.children = children
  }
}

/// One walk of an app's window: in the order of the tree, as a person reads it, with the
/// parts that do not show left out. Plain rules over any tree, so they run with no app.
public enum AccessibilityWalk {
  /// An element is off the screen when its frame is known and no part of it of a point or
  /// more lies in `visible`, the part of the window that shows. Nothing under such an element
  /// shows either, so the walk does not go into it. A frame that the tree does not give, or
  /// one with no size (a group that only holds others), says nothing: the walk goes in.
  public static func offScreen(_ frame: CGRect?, visible: CGRect) -> Bool {
    guard let frame = frame?.standardized, frame.minX.isFinite, frame.minY.isFinite, frame.width.isFinite,
      frame.height.isFinite, frame.width >= 1, frame.height >= 1 else { return false }
    let shown = frame.intersection(visible)
    return shown.isNull || shown.width < 1 || shown.height < 1
  }

  /// Roles of a list of rows that can be very long: a table of mail, a list of files.
  static let rowLists: Set<String> = ["AXTable", "AXOutline"]

  /// The children that the walk goes into. A table or an outline gives the rows that show and
  /// its header, when it names the rows that show: a long list has thousands of rows that do
  /// not show, and asking each one where it is takes longer than the rest of the window. Any
  /// other element that names the children that show gives those. Else all children.
  public static func children<Node>(role: String, all: [Node], visibleChildren: [Node], visibleRows: [Node], header: Node?) -> [Node] {
    if rowLists.contains(role), !visibleRows.isEmpty { return (header.map { [$0] } ?? []) + visibleRows }
    if !visibleChildren.isEmpty { return visibleChildren }
    return all
  }

  /// Walks the tree from `root`, depth first and in the order of the tree. `visible` is the
  /// part of the window that shows, `clock` gives seconds, and `visit` asks one element. An
  /// element off the screen is not kept, and nothing under it is asked.
  public static func walk<Node>(from root: Node, limits: WalkLimits = .look, visible: CGRect, clock: () -> Double,
                                visit: (Node) -> WalkVisit<Node>) -> (elements: [RawElement], visited: Int, end: WalkEnd) {
    let deadline = clock() + limits.seconds
    var stack: [(Node, Int)] = [(root, 0)]
    var elements: [RawElement] = []
    var visited = 0
    while let (node, depth) = stack.popLast() {
      if visited >= limits.visits { return (elements, visited, .visits) }
      if clock() >= deadline { return (elements, visited, .time) }
      visited += 1
      let seen = visit(node)
      if offScreen(seen.frame, visible: visible) { continue }
      if let element = seen.element { elements.append(element) }
      // The last child goes on the stack first, so the tree is read in its own order.
      if depth < limits.depth { for child in seen.children.reversed() { stack.append((child, depth + 1)) } }
    }
    return (elements, visited, .whole)
  }
}
