/// A bounded union of AX window references, compared by native element identity.
/// Callers must also bound each source list before reading supplemental entries.
public enum BoundedWindowCandidates {
  public static func merge<Element>(_ windows: [Element], supplemental: [Element], maximum: Int = 32,
      same: (Element, Element) -> Bool) -> [Element]? {
    guard maximum > 0, maximum <= 32, windows.count <= maximum, supplemental.count <= 2 else { return nil }
    var unique = [Element]()
    for element in windows + supplemental {
      if unique.contains(where: { same($0, element) }) { continue }
      guard unique.count < maximum else { return nil }
      unique.append(element)
    }
    return unique
  }
}
