import ClawdTimeAppCore
import SwiftUI

/// Uninstall ClawdTime…: the list of what goes to the Trash and what stays,
/// the "Keep my settings and keys" box, then the result. The list is the
/// runtime's own (`clawdtime uninstall --plan --json`), so the sheet shows
/// exactly what the command moves.
struct UninstallSheet: View {
  @ObservedObject var model: UninstallModel
  var cancel: () -> Void

  static let size = CGSize(width: 560, height: 520)

  /// While it runs, and once ClawdTime is gone, the sheet closes only by its own buttons.
  static func holdsOpen(_ phase: UninstallModel.Phase) -> Bool {
    switch phase {
    case .running, .finished, .appNotMoved: true
    default: false
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Text("Uninstall ClawdTime").font(.system(size: 18, weight: .semibold))
      content
    }
    .padding(24)
    .frame(width: Self.size.width, height: Self.size.height, alignment: .topLeading)
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .tint(Theme.primary)
  }

  @ViewBuilder private var content: some View {
    switch model.phase {
    case .loading:
      waiting("Reading what ClawdTime would move…")
      Spacer(minLength: 0)
      buttons { Button("Cancel", action: cancel).buttonStyle(SmallPill(kind: .secondary)) }
    case .ready:
      if let plan = model.plan { list(plan) }
      Spacer(minLength: 0)
      Toggle("Keep my settings and keys", isOn: $model.keepSettings).toggleStyle(.checkbox).font(.system(size: 13))
      buttons {
        Button("Cancel", action: cancel).buttonStyle(SmallPill(kind: .secondary)).keyboardShortcut(.cancelAction)
        Button("Uninstall") { Task { await model.uninstall() } }.buttonStyle(SmallPill(kind: .danger))
      }
    case .running:
      waiting("Uninstalling. ClawdTime stops, unpairs this Mac and moves its files to the Trash…")
      Spacer(minLength: 0)
    case .unavailable(let text), .failed(let text):
      result(text, symbol: "exclamationmark.circle.fill", color: Theme.danger)
      buttons { Button("Close", action: cancel).buttonStyle(SmallPill(kind: .secondary)).keyboardShortcut(.cancelAction) }
    case .finished(let text):
      result(text, symbol: "checkmark.circle.fill", color: Theme.primary)
      buttons {
        Button("Move ClawdTime to the Trash and Quit") { model.finish() }
          .buttonStyle(SmallPill(kind: .primary)).keyboardShortcut(.defaultAction)
      }
    case .appNotMoved(let text):
      result(text, symbol: "exclamationmark.circle.fill", color: Theme.danger)
      buttons { Button("Quit") { model.finish() }.buttonStyle(SmallPill(kind: .primary)).keyboardShortcut(.defaultAction) }
    }
  }

  private func list(_ plan: UninstallPlan) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 10) {
        Text(plan.unpair.map { "ClawdTime stops its desktop and its phone connection, and unpairs this Mac from the shared number at \($0.origin). Then it moves these to the Trash:" }
          ?? "ClawdTime stops its desktop and its phone connection. Then it moves these to the Trash:")
          .font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
        rows(plan.moves(keepSettings: model.keepSettings).map { ($0.display, $0.what) })
        Text("ClawdTime.app goes to the Trash last. Nothing is deleted.")
          .font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
        let kept = plan.kept(keepSettings: model.keepSettings)
        if !kept.isEmpty {
          Text("These stay where they are:").font(.system(size: 13))
          rows(kept.map { ($0.display, $0.why) })
        }
        ForEach(plan.notes, id: \.self) { note in
          Text(note).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }

  private func rows(_ rows: [(String, String)]) -> some View {
    SettingsGroup {
      ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
        if index > 0 { RowDivider() }
        VStack(alignment: .leading, spacing: 2) {
          Text(row.0).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
          Text(row.1).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
      }
    }
  }

  private func waiting(_ text: String) -> some View {
    HStack(spacing: 10) {
      ProgressView().controlSize(.small)
      Text(text).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
    }
  }

  private func result(_ text: String, symbol: String, color: Color) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      Image(systemName: symbol).font(.system(size: 22)).foregroundStyle(color).accessibilityHidden(true)
      ScrollView {
        Text(text).font(.system(size: 12, design: .monospaced)).textSelection(.enabled)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .frame(maxHeight: .infinity, alignment: .top)
  }

  private func buttons<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    HStack(spacing: 10) {
      Spacer(minLength: 0)
      content()
    }
  }
}
