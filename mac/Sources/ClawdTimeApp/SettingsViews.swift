import AppKit
import ClawdTimeAppCore
import SwiftUI

/// The four pages of the Settings window.
enum SettingsTab: String, CaseIterable, Identifiable {
  case keys, model, permissions, general
  var id: String { rawValue }
  var title: String {
    switch self {
    case .keys: "Model keys"
    case .model: "Planner model"
    case .permissions: "Permissions"
    case .general: "General"
    }
  }
  var subtitle: String {
    switch self {
    case .keys: "ClawdTime plans each step with a language model. Add a key for the provider you use."
    case .model: "The model that plans each step on this Mac."
    case .permissions: "What macOS lets the panel and the capture helper do."
    case .general: "Start, stop and set up ClawdTime."
    }
  }
  var symbol: String {
    switch self {
    case .keys: "key.fill"
    case .model: "cpu"
    case .permissions: "lock.shield.fill"
    case .general: "gearshape.fill"
    }
  }
}

/// What the General page can do, from the app delegate.
struct SettingsActions {
  var runSetup: () -> Void = {}
  var stop: () -> Void = {}
}

/// The Settings window: a list of pages on the left, the page on the right.
struct SettingsRootView: View {
  @ObservedObject var model: SettingsModel
  @ObservedObject var owner: ProcessOwner
  @ObservedObject var setup: SetupCoordinator
  let loginItem: LoginItemControlling
  var actions = SettingsActions()
  /// Uninstall ClawdTime… on the General page. Nil: the page has no such row.
  var uninstall: UninstallModel?
  @State private var tab: SettingsTab
  /// For the pictures of the tests: a key field or a removal that is open.
  private let editing: String?
  private let removing: String?
  @Namespace private var selection
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let size = CGSize(width: 760, height: 620)

  init(model: SettingsModel, owner: ProcessOwner, setup: SetupCoordinator, loginItem: LoginItemControlling,
       actions: SettingsActions = SettingsActions(), uninstall: UninstallModel? = nil, tab: SettingsTab = .keys,
       editing: String? = nil, removing: String? = nil) {
    self.model = model; self.owner = owner; self.setup = setup; self.loginItem = loginItem; self.actions = actions
    self.uninstall = uninstall
    _tab = State(initialValue: tab)
    self.editing = editing; self.removing = removing
  }

  var body: some View {
    HStack(spacing: 0) {
      sidebar
      Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea()
      ZStack(alignment: .top) {
        page(tab)
          .id(tab)
          .transition(reduceMotion ? .opacity : .asymmetric(
            insertion: .offset(y: 14).combined(with: .opacity),
            removal: .opacity))
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .animation(reduceMotion ? nil : Theme.spring, value: tab)
    }
    .frame(width: Self.size.width, height: Self.size.height)
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .tint(Theme.primary)
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 10) {
        ZStack {
          Circle().fill(Theme.primary)
          Image(systemName: "video.fill").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.onPrimary)
        }
        .frame(width: 26, height: 26)
        .accessibilityHidden(true)
        Text("Settings").font(.system(size: 15, weight: .semibold))
      }
      .padding(.horizontal, 8)
      .padding(.bottom, 16)
      ForEach(SettingsTab.allCases) { item in
        Button {
          tab = item
        } label: {
          HStack(spacing: 10) {
            Image(systemName: item.symbol).font(.system(size: 12, weight: .semibold)).frame(width: 18)
            Text(item.title).font(.system(size: 13, weight: .medium))
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 10)
          .frame(height: 32)
          .foregroundStyle(tab == item ? Theme.onTint : Theme.text)
          .background {
            if tab == item {
              RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.tint)
                .matchedGeometryEffect(id: "selection", in: selection)
            }
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(tab == item ? .isSelected : [])
      }
      Spacer()
      Text("ClawdTime \(model.about.app)")
        .font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
        .padding(.horizontal, 8)
    }
    .padding(.top, 48)
    .padding(.bottom, 18)
    .padding(.horizontal, 12)
    .frame(width: 196)
    .frame(maxHeight: .infinity, alignment: .top)
  }

  @ViewBuilder private func page(_ tab: SettingsTab) -> some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 4) {
          Text(tab.title).font(.system(size: 22, weight: .semibold))
          Text(tab.subtitle).font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
            .fixedSize(horizontal: false, vertical: true)
        }
        Notices(model: model)
        switch tab {
        case .keys: KeysPage(model: model, editing: editing, removing: removing)
        case .model: ModelPage(model: model)
        case .permissions: PermissionsPage(model: model)
        case .general: GeneralPage(model: model, owner: owner, setup: setup, loginItem: loginItem, actions: actions, uninstall: uninstall)
        }
      }
      .padding(.horizontal, 30)
      .padding(.top, 44)
      .padding(.bottom, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.automatic)
  }
}

// MARK: Pieces

/// A rounded group of rows, as on the setup cards.
struct SettingsGroup<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 0) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

struct RowDivider: View {
  var body: some View { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 16) }
}

/// A small pill, for the buttons inside a row.
struct SmallPill: ButtonStyle {
  enum Kind { case primary, secondary, danger }
  var kind: Kind
  @Environment(\.isEnabled) private var isEnabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12, weight: .semibold))
      .padding(.horizontal, 12)
      .frame(height: 26)
      .foregroundStyle(kind == .primary ? Theme.onPrimary : kind == .danger ? Theme.danger : Theme.text)
      .background(Capsule().fill(kind == .primary ? Theme.primary : Theme.surface))
      .overlay(Capsule().strokeBorder(kind == .primary ? Color.clear : kind == .danger ? Theme.danger.opacity(0.55) : Theme.line, lineWidth: 1))
      .opacity(isEnabled ? 1 : 0.45)
      .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
      .animation(Theme.quick, value: configuration.isPressed)
      .contentShape(Capsule())
  }
}

struct SettingsField: ViewModifier {
  func body(content: Content) -> some View {
    content
      .textFieldStyle(.plain)
      .font(.system(size: 13))
      .padding(.horizontal, 12)
      .frame(height: 32)
      .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

/// On, Off or Not found, as a small tag.
struct StatusTag: View {
  enum Look { case on, off, neutral }
  var text: String
  var look: Look
  var symbol: String?
  var body: some View {
    HStack(spacing: 4) {
      if let symbol { Image(systemName: symbol).font(.system(size: 9, weight: .bold)) }
      Text(text).font(.system(size: 11, weight: .semibold))
    }
    .padding(.horizontal, 9)
    .frame(height: 22)
    .foregroundStyle(look == .on ? Theme.onTint : look == .off ? Theme.danger : Theme.secondaryText)
    .background(Capsule().fill(look == .on ? Theme.tint : Theme.background))
    .overlay(Capsule().strokeBorder(look == .on ? Color.clear : look == .off ? Theme.danger.opacity(0.45) : Theme.line, lineWidth: 1))
    .accessibilityElement(children: .combine)
  }
}

/// The note after a change, and the last problem.
struct Notices: View {
  @ObservedObject var model: SettingsModel
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if let problem = model.problem {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: "exclamationmark.circle.fill").foregroundStyle(Theme.danger)
          Text(problem).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button { model.dismissProblem() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
            .buttonStyle(.plain).foregroundStyle(Theme.secondaryText).accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.danger.opacity(0.45), lineWidth: 1))
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
      if let note = model.restart {
        HStack(alignment: .center, spacing: 10) {
          Image(systemName: note == .restarting ? "arrow.clockwise.circle.fill" : "checkmark.circle.fill")
            .foregroundStyle(Theme.onTint)
          Text(SettingsWords.restart(note)).font(.system(size: 12)).foregroundStyle(Theme.onTint)
            .fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          if case .offer = note {
            Button("Restart now") { model.restartNow() }.buttonStyle(SmallPill(kind: .primary))
          }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.tint.opacity(0.7)))
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .animation(reduceMotion ? nil : Theme.spring, value: model.problem)
    .animation(reduceMotion ? nil : Theme.spring, value: model.restart)
  }
}

/// The words of the Settings window, kept apart so tests can read them.
enum SettingsWords {
  static func restart(_ note: SettingsModel.RestartNote) -> String {
    switch note {
    case .nextStart: "Saved. The desktop uses it when it starts."
    case .restarting: "Saved. The desktop restarts to use it."
    case .offer(let reason): "Saved. The desktop restarts to use it when you choose. \(reason)"
    }
  }

  /// The name of a provider on a page: the custom one reads as a name too.
  static func name(_ row: ProviderKey) -> String { row.needsBaseUrl ? "Custom service" : row.name }

  static func key(_ row: ProviderKey) -> String {
    switch row.source {
    case .store: "Stored on this Mac."
    case .environment: "From the environment: \(row.variable ?? "a variable")."
    case nil: row.needsBaseUrl ? "Not set. Your service may need none." : "Not set."
    }
  }

  /// The model a provider plans with when it has a key, in a few words.
  static func defaultModel(_ row: ProviderKey) -> String {
    row.defaultModel ?? (row.needsBaseUrl ? "your model and address" : "you choose the model")
  }

  static func modelSource(_ report: ModelReport) -> String {
    switch report.from {
    case .environment: "Set in the environment: \(report.variable ?? "CLAWDTIME_COMPUTER_MODEL"). It wins over a choice here."
    case .store: "Chosen here."
    case .default: report.ok ? "Automatic: the default model of the first provider with a key." : "Automatic."
    }
  }

  static func modelKey(_ report: ModelReport) -> String? {
    guard report.ok, let key = report.key else { return nil }
    switch key.source {
    case .store: return "Key: stored on this Mac."
    case .environment: return "Key: from the environment, \(key.variable ?? "a variable")."
    case nil: return "Key: none. The custom service gets no key."
    }
  }

  /// What stops the planner, in short words. The runtime's own sentence when no short one fits.
  static func modelProblem(_ report: ModelReport) -> String? {
    guard !report.ok else { return nil }
    let name = report.providerName ?? "this provider"
    switch report.reason {
    case "no_key": return "No key yet. Add one in Model keys."
    case "missing_key": return "No key for \(name). Add one in Model keys."
    case "no_model": return "\(name) has no default model. Choose one below."
    default:
      if report.provider == "custom" && report.baseUrl == nil { return "The custom provider needs its base address." }
      return report.problem ?? "The planner cannot start."
    }
  }
}

// MARK: Model keys

struct KeysPage: View {
  @ObservedObject var model: SettingsModel
  @State private var editing: String?
  @State private var removing: String?
  @State private var key = ""
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(model: SettingsModel, editing: String? = nil, removing: String? = nil) {
    self.model = model
    _editing = State(initialValue: editing)
    _removing = State(initialValue: removing)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if let report = model.keys {
        SettingsGroup {
          ForEach(Array(report.providers.enumerated()), id: \.element.id) { index, row in
            if index > 0 { RowDivider() }
            KeyRow(row: row, working: model.work == .key(row.id), open: editing == row.id || removing == row.id,
                   add: { open(row.id) }, remove: { withAnimation(spring) { removing = row.id; editing = nil } })
            if editing == row.id { editor(row).transition(.opacity.combined(with: .move(edge: .top))) }
            if removing == row.id { confirm(row).transition(.opacity.combined(with: .move(edge: .top))) }
          }
        }
        Text("Keys stay on this Mac, in a file that only you can read. ClawdTime never shows a key again. A key from the environment wins over a stored one, and you change it where it is set.")
          .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        if let problem = report.problem {
          Label(problem, systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        Loading()
      }
    }
  }

  private var spring: Animation? { reduceMotion ? nil : Theme.spring }

  private func open(_ id: String) {
    key = ""
    withAnimation(spring) { editing = id; removing = nil }
  }

  private func editor(_ row: ProviderKey) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        SecureField("Paste the key for \(SettingsWords.name(row))", text: $key)
          .onSubmit { save(row) }
          .modifier(SettingsField())
          .accessibilityLabel("Key for \(SettingsWords.name(row))")
        Button("Cancel") { key = ""; withAnimation(spring) { editing = nil } }.buttonStyle(SmallPill(kind: .secondary))
        Button("Save") { save(row) }.buttonStyle(SmallPill(kind: .primary))
          .disabled(key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || model.work != nil)
          .keyboardShortcut(.defaultAction)
      }
      Text("The key goes to protected storage on this Mac.")
        .font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 12)
  }

  private func confirm(_ row: ProviderKey) -> some View {
    HStack(spacing: 8) {
      Text("Remove the key for \(SettingsWords.name(row))? ClawdTime stops using it.")
        .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button("Cancel") { withAnimation(spring) { removing = nil } }.buttonStyle(SmallPill(kind: .secondary))
      Button("Remove") {
        let id = row.id
        Task {
          await model.removeKey(provider: id)
          withAnimation(spring) { removing = nil }
        }
      }
      .buttonStyle(SmallPill(kind: .danger))
      .disabled(model.work != nil)
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 12)
  }

  private func save(_ row: ProviderKey) {
    let typed = key
    guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.work == nil else { return }
    // The field lets go of the key as soon as it is sent.
    key = ""
    let id = row.id
    Task {
      if await model.setKey(provider: id, key: typed) { withAnimation(spring) { editing = nil } }
    }
  }
}

struct KeyRow: View {
  var row: ProviderKey
  var working: Bool
  /// Its field or its question is open below it: the buttons are there.
  var open = false
  var add: () -> Void
  var remove: () -> Void
  var body: some View {
    HStack(spacing: 12) {
      Circle()
        .fill(row.set ? Theme.primary : Color.clear)
        .overlay(Circle().strokeBorder(row.set ? Color.clear : Theme.line, lineWidth: 1.5))
        .frame(width: 9, height: 9)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(SettingsWords.name(row)).font(.system(size: 13, weight: .semibold))
          Text(SettingsWords.defaultModel(row))
            .font(.system(size: 11, design: row.defaultModel == nil ? .default : .monospaced))
            .foregroundStyle(Theme.secondaryText).lineLimit(1)
        }
        Text(SettingsWords.key(row)).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
          .lineLimit(1).truncationMode(.middle)
      }
      Spacer(minLength: 8)
      if working {
        ProgressView().controlSize(.small)
      } else if open {
        EmptyView()
      } else if row.source == .environment {
        StatusTag(text: "Environment", look: .neutral, symbol: "lock.fill")
          .help("This key is set outside ClawdTime. Change it where it is set.")
      } else if row.stored {
        Button("Replace", action: add).buttonStyle(SmallPill(kind: .secondary))
        Button("Remove", action: remove).buttonStyle(SmallPill(kind: .danger))
      } else {
        Button("Add", action: add).buttonStyle(SmallPill(kind: .secondary))
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 10)
    .accessibilityElement(children: .contain)
  }
}

struct Loading: View {
  var body: some View {
    HStack(spacing: 10) {
      ProgressView().controlSize(.small)
      Text("Reading settings").font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
    }
    .padding(.vertical, 8)
  }
}

// MARK: Planner model

struct ModelPage: View {
  @ObservedObject var model: SettingsModel
  @State private var provider: String
  @State private var name: String
  @State private var base: String
  @State private var filled: Bool
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  static let automatic = "auto"

  init(model: SettingsModel) {
    self.model = model
    let start = Self.start(model.model)
    _provider = State(initialValue: start.provider)
    _name = State(initialValue: start.name)
    _base = State(initialValue: start.base)
    _filled = State(initialValue: model.model != nil)
  }

  /// The choice the page opens with: the stored one, or the automatic one.
  static func start(_ report: ModelReport?) -> (provider: String, name: String, base: String) {
    guard let report, report.from == .store, let id = report.provider else { return (automatic, "", "") }
    return (id, report.model ?? "", report.baseUrl ?? "")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      if let report = model.model, let keys = model.keys {
        current(report)
        change(keys)
      } else {
        Loading()
      }
    }
    .onChange(of: model.model) { _, report in
      guard !filled, report != nil else { return }
      filled = true
      let start = Self.start(report)
      provider = start.provider
      name = start.name
      base = start.base
    }
    .animation(reduceMotion ? nil : Theme.spring, value: provider)
  }

  private func current(_ report: ModelReport) -> some View {
    SettingsGroup {
      VStack(alignment: .leading, spacing: 6) {
        Text("In use").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondaryText)
        Text(report.name ?? "None yet").font(.system(size: 17, weight: .semibold, design: .monospaced))
          .textSelection(.enabled)
        Text(SettingsWords.modelSource(report)).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
        if let key = SettingsWords.modelKey(report) {
          Text(key).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
        }
        if let problem = SettingsWords.modelProblem(report) {
          Label(problem, systemImage: "exclamationmark.circle").font(.system(size: 12)).foregroundStyle(Theme.danger)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(16)
    }
  }

  private func change(_ keys: KeysReport) -> some View {
    let chosen = keys.providers.first { $0.id == provider }
    return SettingsGroup {
      VStack(alignment: .leading, spacing: 12) {
        Text("Change it").font(.system(size: 13, weight: .semibold))
        LabeledRow(label: "Provider") {
          Picker("Provider", selection: Binding(get: { provider }, set: choose)) {
            Text("Automatic").tag(Self.automatic)
            Divider()
            ForEach(keys.providers) { row in
              Text(row.set || row.needsBaseUrl ? SettingsWords.name(row) : "\(row.name) (no key)").tag(row.id)
            }
          }
          .labelsHidden()
          .frame(maxWidth: 260, alignment: .leading)
        }
        if let chosen {
          LabeledRow(label: "Model") {
            TextField(chosen.defaultModel ?? "a model that reads pictures", text: $name)
              .modifier(SettingsField())
              .font(.system(size: 13, design: .monospaced))
          }
          .transition(.opacity)
          if chosen.needsBaseUrl {
            LabeledRow(label: "Base address") {
              TextField("https://models.example/v1", text: $base).modifier(SettingsField())
            }
            .transition(.opacity)
          }
          Text(chosen.needsModel
               ? "Choose a model that reads pictures. Run the planner test before you rely on it."
               : "Leave the default, or name another model of \(SettingsWords.name(chosen)).")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        } else {
          Text("ClawdTime uses the first provider with a key, with its default model.")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
        HStack {
          Spacer()
          if model.work == .model { ProgressView().controlSize(.small) }
          Button(chosen == nil ? "Use automatic" : "Use this model", action: apply)
            .buttonStyle(PillStyle(kind: .primary))
            .disabled(model.work != nil || (chosen != nil && name.trimmingCharacters(in: .whitespaces).isEmpty))
        }
      }
      .padding(16)
    }
  }

  private func choose(_ id: String) {
    provider = id
    name = model.provider(id)?.defaultModel ?? ""
    base = model.model?.provider == id ? (model.model?.baseUrl ?? "") : ""
  }

  private func apply() {
    let id = provider == Self.automatic ? nil : provider
    let (name, base) = (name, base)
    Task { await model.chooseModel(provider: id, model: name, baseURL: base) }
  }
}

struct LabeledRow<Content: View>: View {
  var label: String
  @ViewBuilder var content: Content
  var body: some View {
    HStack(spacing: 12) {
      Text(label).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.secondaryText)
        .frame(width: 96, alignment: .leading)
      content
    }
  }
}

// MARK: Permissions

struct PermissionsPage: View {
  @ObservedObject var model: SettingsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsGroup {
        row("Accessibility", who: "Panel", detail: "Lets ClawdTime click and type for you.", granted: model.permissions?.panelAccessibility, pane: .accessibility)
        RowDivider()
        row("Screen Recording", who: "Panel", detail: "Lets the panel see the screen.", granted: model.permissions?.panelScreenRecording, pane: .screenRecording)
        RowDivider()
        row("Screen Recording", who: "Capture helper", detail: "Lets ClawdTime show your screen on a call.", granted: model.permissions?.captureScreenRecording, pane: .screenRecording)
      }
      HStack(alignment: .top) {
        Text("In System Settings, open Privacy & Security. Turn on ClawdTime in Accessibility and in Screen & System Audio Recording. This page checks again when you come back.")
          .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 12)
        Button("Check again") { Task { await model.checkPermissions() } }
          .buttonStyle(SmallPill(kind: .secondary)).disabled(model.work == .permissions)
      }
    }
    // Live: the page asks again every few seconds while it is open.
    .task {
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        if Task.isCancelled { break }
        await model.checkPermissions(quietly: true)
      }
    }
  }

  private func row(_ title: String, who: String, detail: String, granted: Bool?, pane: PermissionPane) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text("\(who): \(title)").font(.system(size: 13, weight: .semibold))
        Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
      }
      Spacer(minLength: 8)
      switch granted {
      case true?: StatusTag(text: "On", look: .on, symbol: "checkmark")
      case false?:
        Button("Open System Settings") { model.openSettings(pane) }.buttonStyle(SmallPill(kind: .secondary))
        StatusTag(text: "Off", look: .off)
      case nil: StatusTag(text: "Not found", look: .neutral)
      }
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .accessibilityElement(children: .contain)
  }
}

// MARK: General

struct GeneralPage: View {
  @ObservedObject var model: SettingsModel
  @ObservedObject var owner: ProcessOwner
  @ObservedObject var setup: SetupCoordinator
  let loginItem: LoginItemControlling
  var actions: SettingsActions
  var uninstall: UninstallModel?
  @State private var openAtLogin: Bool
  @State private var loginNote: String?
  @State private var uninstalling = false

  init(model: SettingsModel, owner: ProcessOwner, setup: SetupCoordinator, loginItem: LoginItemControlling, actions: SettingsActions,
       uninstall: UninstallModel? = nil) {
    self.model = model; self.owner = owner; self.setup = setup; self.loginItem = loginItem; self.actions = actions
    self.uninstall = uninstall
    _openAtLogin = State(initialValue: loginItem.isEnabled)
    _loginNote = State(initialValue: loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      SettingsGroup {
        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text("Open ClawdTime when you log in").font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 8)
            Toggle("Open ClawdTime when you log in", isOn: Binding(get: { openAtLogin }, set: setLogin))
              .toggleStyle(.switch).labelsHidden()
          }
          if let loginNote {
            Text(loginNote).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
          }
        }
        .padding(16)
      }
      SettingsGroup {
        action("Setup", detail: "Checks each step again. A step that is ready stays as it is.") {
          Button("Run setup again", action: actions.runSetup).buttonStyle(SmallPill(kind: .secondary))
        }
        RowDivider()
        action("Desktop and connection", detail: "Desktop: \(MenuText.status(owner.desktop)). Connection: \(MenuText.status(owner.connection)). Stop ends setup and every process ClawdTime started.") {
          Button { actions.stop() } label: { Label("Stop", systemImage: "stop.fill") }
            .buttonStyle(SmallPill(kind: .danger))
            .disabled(!(owner.isActive || setup.engineIsRunning))
        }
      }
      if let uninstall {
        SettingsGroup {
          action("Uninstall", detail: "Stops ClawdTime, unpairs this Mac and moves ClawdTime and its files to the Trash. It deletes nothing.") {
            Button("Uninstall ClawdTime…") {
              uninstalling = true
              Task { await uninstall.load() }
            }
            .buttonStyle(SmallPill(kind: .danger))
          }
        }
        .sheet(isPresented: $uninstalling) {
          UninstallSheet(model: uninstall, cancel: { uninstalling = false })
            .interactiveDismissDisabled(UninstallSheet.holdsOpen(uninstall.phase))
        }
      }
      SettingsGroup {
        VStack(alignment: .leading, spacing: 4) {
          Text("ClawdTime \(model.about.app)").font(.system(size: 13, weight: .semibold))
          Text(runtimeLine).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondaryText)
            .textSelection(.enabled)
        }
        .padding(16)
      }
    }
    .onAppear {
      openAtLogin = loginItem.isEnabled
      loginNote = loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil
    }
  }

  private var runtimeLine: String {
    guard let runtime = model.about.runtime else { return "No runtime" }
    return "Runtime \(runtime)" + (model.about.shortCommit.map { " · commit \($0)" } ?? "")
  }

  private func action<Trailing: View>(_ title: String, detail: String, @ViewBuilder trailing: () -> Trailing) -> some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold))
        Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      trailing()
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
  }

  private func setLogin(_ enabled: Bool) {
    do {
      try loginItem.setEnabled(enabled)
      openAtLogin = loginItem.isEnabled
      loginNote = loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil
    } catch {
      openAtLogin = loginItem.isEnabled
      loginNote = "macOS did not change this. Try again from System Settings, Login Items."
    }
  }
}
