import AppKit
import ClawdTimeAppCore
import SwiftUI

/// What the pages can do, from the app delegate.
struct SettingsActions {
  var runSetup: () -> Void = {}
  var stop: () -> Void = {}
}

/// A row that the search found, to show for a moment after the page opens.
private struct HighlightKey: EnvironmentKey { static let defaultValue: String? = nil }
extension EnvironmentValues {
  var settingsHighlight: String? {
    get { self[HighlightKey.self] }
    set { self[HighlightKey.self] = newValue }
  }
}

/// For the pictures of the tests: a field or a question that is open.
struct SettingsPreview: Equatable {
  var editingKey: String?
  var removingKey: String?
  /// "forget", "history" or "unpair": the question of that button is open.
  var confirming: String?
  var advanced = false
}

/// The Settings window: the sections and a search field on the left, the
/// section on the right. Up and Down move through the sections, Command-1 to
/// Command-8 open one, Command-F goes to the search field, and Escape clears it.
struct SettingsRootView: View {
  @ObservedObject var model: SettingsModel
  @ObservedObject var owner: ProcessOwner
  @ObservedObject var setup: SetupCoordinator
  let loginItem: LoginItemControlling
  var actions = SettingsActions()
  /// Uninstall ClawdTime… in About. Nil: the page has no such row.
  var uninstall: UninstallModel?
  @State private var section: SettingsSection
  @State private var query: String
  @State private var highlight: String?
  @FocusState private var focus: Focus?
  private let preview: SettingsPreview
  /// The height of the window. The pictures of the tests draw a long section whole.
  private let height: CGFloat
  @Namespace private var selection
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  enum Focus: Hashable { case search, sections }

  static let size = CGSize(width: 840, height: 660)

  init(model: SettingsModel, owner: ProcessOwner, setup: SetupCoordinator, loginItem: LoginItemControlling,
       actions: SettingsActions = SettingsActions(), uninstall: UninstallModel? = nil, section: SettingsSection = .general,
       query: String = "", preview: SettingsPreview = SettingsPreview(), height: CGFloat = SettingsRootView.size.height) {
    self.model = model; self.owner = owner; self.setup = setup; self.loginItem = loginItem; self.actions = actions
    self.uninstall = uninstall
    _section = State(initialValue: section)
    _query = State(initialValue: query)
    self.preview = preview
    self.height = height
  }

  var body: some View {
    HStack(spacing: 0) {
      sidebar
      Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea()
      content
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .frame(width: Self.size.width, height: height)
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .tint(Theme.primary)
    .background(shortcuts)
  }

  private var spring: Animation? { reduceMotion ? nil : Theme.spring }

  // MARK: sidebar

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 2) {
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
      .padding(.bottom, 12)
      SearchField(text: $query, focus: $focus)
        .padding(.bottom, 10)
      VStack(alignment: .leading, spacing: 2) {
        ForEach(Array(SettingsSection.allCases.enumerated()), id: \.element) { index, item in
          sectionButton(item, number: index + 1)
        }
      }
      .focusable()
      .focused($focus, equals: .sections)
      .focusEffectDisabled()
      .onMoveCommand(perform: move)
      .overlay {
        if focus == .sections {
          RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Theme.primary.opacity(0.5), lineWidth: 2).padding(-3)
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Sections")
      Spacer()
      Text("ClawdTime \(model.about.app)")
        .font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
        .padding(.horizontal, 8)
    }
    .padding(.top, 44)
    .padding(.bottom, 18)
    .padding(.horizontal, 12)
    .frame(width: 212)
    .frame(maxHeight: .infinity, alignment: .top)
  }

  private func sectionButton(_ item: SettingsSection, number: Int) -> some View {
    let chosen = query.isEmpty && section == item
    return Button {
      open(item)
    } label: {
      HStack(spacing: 10) {
        Image(systemName: item.symbol).font(.system(size: 12, weight: .semibold)).frame(width: 18)
        Text(item.title).font(.system(size: 13, weight: .medium))
        Spacer(minLength: 0)
        if let badge = badge(item) {
          Circle().fill(Theme.danger).frame(width: 7, height: 7).help(badge).accessibilityLabel(badge)
        }
      }
      .padding(.horizontal, 10)
      .frame(height: 30)
      .foregroundStyle(chosen ? Theme.onTint : Theme.text)
      .background {
        if chosen {
          RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.tint)
            .matchedGeometryEffect(id: "selection", in: selection)
        }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("\(item.title) (Command-\(number))")
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  /// A red dot on a section that needs the person: a permission that is off.
  private func badge(_ item: SettingsSection) -> String? {
    guard item == .permissions, let permissions = model.permissions else { return nil }
    let values = [permissions.panelAccessibility, permissions.panelScreenRecording, permissions.captureScreenRecording]
    return values.contains(false) ? "A permission is off" : nil
  }

  private func open(_ item: SettingsSection, anchor: String? = nil) {
    withAnimation(spring) {
      query = ""
      section = item
      highlight = anchor
    }
  }

  private func move(_ direction: MoveCommandDirection) {
    let all = SettingsSection.allCases
    guard let index = all.firstIndex(of: section) else { return }
    switch direction {
    case .up where index > 0: open(all[index - 1])
    case .down where index < all.count - 1: open(all[index + 1])
    default: break
    }
  }

  /// Command-1 to Command-8 and Command-F, as buttons with no size.
  private var shortcuts: some View {
    ZStack {
      ForEach(Array(SettingsSection.allCases.enumerated()), id: \.element) { index, item in
        Button("") { open(item) }.keyboardShortcut(KeyEquivalent(Character(String(index + 1))), modifiers: .command)
      }
      Button("") { focus = .search }.keyboardShortcut("f", modifiers: .command)
    }
    .opacity(0)
    .frame(width: 0, height: 0)
    .accessibilityHidden(true)
  }

  // MARK: content

  @ViewBuilder private var content: some View {
    if !query.trimmingCharacters(in: .whitespaces).isEmpty {
      SearchResults(query: query, choose: { open($0.section, anchor: $0.anchor) })
        .transition(.opacity)
    } else {
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 4) {
              Text(section.title).font(.system(size: 22, weight: .semibold))
              Text(section.subtitle).font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
                .fixedSize(horizontal: false, vertical: true)
            }
            Notices(model: model)
            page(section)
          }
          .padding(.horizontal, 30)
          .padding(.top, 44)
          .padding(.bottom, 28)
          .frame(maxWidth: .infinity, alignment: .leading)
          .id(section)
          .transition(reduceMotion ? .opacity : .asymmetric(insertion: .offset(y: 12).combined(with: .opacity), removal: .opacity))
        }
        .scrollIndicators(.automatic)
        .environment(\.settingsHighlight, highlight)
        .onChange(of: highlight) { _, anchor in
          guard let anchor else { return }
          withAnimation(spring) { proxy.scrollTo(anchor, anchor: .top) }
          // The mark goes after a moment.
          Task {
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            if highlight == anchor { withAnimation(spring) { highlight = nil } }
          }
        }
      }
    }
  }

  @ViewBuilder private func page(_ section: SettingsSection) -> some View {
    switch section {
    case .general: GeneralPage(model: model, owner: owner, setup: setup, loginItem: loginItem, actions: actions)
    case .assistant: AssistantPage(model: model, confirming: preview.confirming)
    case .models: ModelsPage(model: model, preview: preview)
    case .computer: ComputerPage(model: model)
    case .permissions: PermissionsPage(model: model)
    case .phone: PhonePage(model: model, actions: actions, confirming: preview.confirming)
    case .privacy: PrivacyPage(model: model, confirming: preview.confirming)
    case .about: AboutPage(model: model, uninstall: uninstall)
    }
  }
}

// MARK: Search

/// The search field of the sidebar. Escape clears it.
struct SearchField: View {
  @Binding var text: String
  var focus: FocusState<SettingsRootView.Focus?>.Binding
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondaryText)
      TextField("Search settings", text: $text)
        .textFieldStyle(.plain)
        .font(.system(size: 13))
        .focused(focus, equals: .search)
        .onExitCommand { text = "" }
        .accessibilityLabel("Search settings")
      if !text.isEmpty {
        Button { text = "" } label: { Image(systemName: "xmark.circle.fill").font(.system(size: 11)) }
          .buttonStyle(.plain).foregroundStyle(Theme.secondaryText).accessibilityLabel("Clear the search")
      }
    }
    .padding(.horizontal, 10)
    .frame(height: 30)
    .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.surface))
    .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous)
      .strokeBorder(focus.wrappedValue == .search ? Theme.primary.opacity(0.6) : Theme.line, lineWidth: 1))
  }
}

/// What the search found, by section. Return opens the first one.
struct SearchResults: View {
  var query: String
  var choose: (SettingsEntry) -> Void
  var body: some View {
    let found = SettingsCatalog.search(query)
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        VStack(alignment: .leading, spacing: 4) {
          Text("Search").font(.system(size: 22, weight: .semibold))
          Text(found.isEmpty ? "No setting has the words \u{201C}\(query)\u{201D}." : "\(found.count) \(found.count == 1 ? "setting" : "settings") for \u{201C}\(query)\u{201D}.")
            .font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
        }
        if !found.isEmpty {
          SettingsGroup {
            ForEach(Array(found.enumerated()), id: \.element.id) { index, entry in
              if index > 0 { RowDivider() }
              Button { choose(entry) } label: {
                HStack(spacing: 12) {
                  Image(systemName: entry.section.symbol).font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Theme.secondaryText).frame(width: 18)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(entry.title).font(.system(size: 13, weight: .semibold))
                    Text(entry.section.title).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
                  }
                  Spacer(minLength: 8)
                  Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondaryText)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .keyboardShortcut(index == 0 ? .defaultAction : nil)
            }
          }
        }
      }
      .padding(.horizontal, 30)
      .padding(.top, 44)
      .padding(.bottom, 28)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
  }
}

// MARK: Pieces

/// A rounded group of rows, as on the setup cards.
struct SettingsGroup<Content: View>: View {
  var title: String?
  @ViewBuilder var content: Content
  init(_ title: String? = nil, @ViewBuilder content: () -> Content) {
    self.title = title
    self.content = content()
  }
  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let title {
        Text(title.uppercased()).font(.system(size: 10.5, weight: .semibold)).tracking(0.6)
          .foregroundStyle(Theme.secondaryText).padding(.leading, 4)
      }
      VStack(alignment: .leading, spacing: 0) { content }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Theme.surface))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
    }
  }
}

struct RowDivider: View {
  var body: some View { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 16) }
}

/// One row: a title, a line about it, and its control on the right. The
/// search finds it by its anchor, and marks it for a moment.
struct SettingRow<Trailing: View>: View {
  var anchor: String?
  var title: String
  var detail: String?
  /// The variable of the environment that holds this setting.
  var fixedBy: String?
  @ViewBuilder var trailing: Trailing
  @Environment(\.settingsHighlight) private var highlight

  init(_ title: String, detail: String? = nil, anchor: String? = nil, fixedBy: String? = nil, @ViewBuilder trailing: () -> Trailing) {
    self.title = title; self.detail = detail; self.anchor = anchor; self.fixedBy = fixedBy
    self.trailing = trailing()
  }

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        Text(title).font(.system(size: 13, weight: .semibold))
        if let detail {
          Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
        if let fixedBy {
          Label("Set in the environment: \(fixedBy). It wins over a choice here.", systemImage: "lock.fill")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 12)
      trailing
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 11)
    .background(anchor != nil && highlight == anchor ? Theme.tint.opacity(0.55) : Color.clear)
    .id(anchor ?? title)
    .accessibilityElement(children: .contain)
  }
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

/// A question under a row before a change that cannot be taken back here.
struct ConfirmRow: View {
  var question: String
  var action: String
  var working: Bool
  var cancel: () -> Void
  var confirm: () -> Void
  var body: some View {
    HStack(spacing: 8) {
      Text(question).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 8)
      if working { ProgressView().controlSize(.small) }
      Button("Cancel", action: cancel).buttonStyle(SmallPill(kind: .secondary)).keyboardShortcut(.cancelAction)
      Button(action, action: confirm).buttonStyle(SmallPill(kind: .danger)).disabled(working)
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 12)
    .transition(.opacity.combined(with: .move(edge: .top)))
  }
}

/// A switch that reads and writes one boolean setting of the runtime.
struct SettingToggle: View {
  @ObservedObject var model: SettingsModel
  var id: String
  var label: String
  var body: some View {
    Toggle(label, isOn: Binding(
      get: { model.value(id)?.bool ?? model.setting(id)?.default.bool ?? false },
      set: { value in Task { await model.set(id, .bool(value)) } }))
      .toggleStyle(.switch).labelsHidden()
      .disabled(model.setting(id) == nil || model.isFixed(id))
      .accessibilityLabel(label)
  }
}

/// A choice of one setting of the runtime, with words for each value.
struct SettingChoice: View {
  enum Look { case segments, menu }
  @ObservedObject var model: SettingsModel
  var id: String
  var label: String
  var names: [(value: String, title: String)]
  var look: Look = .segments
  var width: CGFloat? = nil
  var body: some View {
    let binding = Binding(
      get: { model.value(id)?.text ?? model.setting(id)?.default.text ?? "" },
      set: { value in Task { await model.set(id, .text(value)) } })
    Group {
      switch look {
      case .segments:
        Picker(label, selection: binding) { ForEach(names, id: \.value) { Text($0.title).tag($0.value) } }
          .pickerStyle(.segmented)
      case .menu:
        Picker(label, selection: binding) { ForEach(names, id: \.value) { Text($0.title).tag($0.value) } }
          .pickerStyle(.menu)
      }
    }
    .labelsHidden()
    .frame(width: width)
    .disabled(model.setting(id) == nil || model.isFixed(id))
    .accessibilityLabel(label)
  }
}

/// The note after a change, the last problem, and the last thing that worked.
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
      if let done = model.done {
        HStack(alignment: .center, spacing: 10) {
          Image(systemName: "checkmark.circle.fill").foregroundStyle(Theme.onTint)
          Text(done).font(.system(size: 12)).foregroundStyle(Theme.onTint).fixedSize(horizontal: false, vertical: true)
          Spacer(minLength: 0)
          Button { model.dismissDone() } label: { Image(systemName: "xmark").font(.system(size: 10, weight: .bold)) }
            .buttonStyle(.plain).foregroundStyle(Theme.onTint).accessibilityLabel("Dismiss")
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.tint.opacity(0.7)))
        .transition(.opacity.combined(with: .move(edge: .top)))
      }
    }
    .animation(reduceMotion ? nil : Theme.spring, value: model.problem)
    .animation(reduceMotion ? nil : Theme.spring, value: model.restart)
    .animation(reduceMotion ? nil : Theme.spring, value: model.done)
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

// MARK: Words

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

  /// The title of a speed preset.
  static func preset(_ id: String) -> String {
    switch id {
    case "fast": "Fast"
    case "balanced": "Balanced"
    case "best": "Best"
    default: "Custom"
    }
  }

  static func provider(_ id: String) -> String {
    switch id {
    case "openai": "OpenAI"
    case "anthropic": "Anthropic"
    default: id
    }
  }

  /// Bytes as people read them.
  static func size(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }

  /// A path with the home folder as ~.
  static func tilde(_ path: String) -> String {
    let home = NSHomeDirectory()
    return path.hasPrefix(home + "/") ? "~" + path.dropFirst(home.count) : path
  }

  /// Seconds as people say them.
  static func seconds(_ value: Double) -> String {
    let whole = Int(value.rounded())
    if whole == 0 { return "Call at once" }
    if whole < 60 { return "\(whole) seconds" }
    let minutes = Double(whole) / 60
    return minutes.rounded() == minutes ? "\(Int(minutes)) \(Int(minutes) == 1 ? "minute" : "minutes")" : String(format: "%.1f minutes", minutes)
  }
}
