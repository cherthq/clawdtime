import AppKit
import ClawdTimeAppCore
import SwiftUI

// MARK: General

struct GeneralPage: View {
  @ObservedObject var model: SettingsModel
  @ObservedObject var owner: ProcessOwner
  @ObservedObject var setup: SetupCoordinator
  let loginItem: LoginItemControlling
  var actions: SettingsActions
  @State private var openAtLogin: Bool
  @State private var loginNote: String?
  @State private var size: Double?

  init(model: SettingsModel, owner: ProcessOwner, setup: SetupCoordinator, loginItem: LoginItemControlling, actions: SettingsActions) {
    self.model = model; self.owner = owner; self.setup = setup; self.loginItem = loginItem; self.actions = actions
    _openAtLogin = State(initialValue: loginItem.isEnabled)
    _loginNote = State(initialValue: loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil)
  }

  /// The stones of the mascot, with a color like each one.
  static let styles: [(id: String, name: String, color: Color)] = [
    ("flint", "Flint", Color(red: 0.23, green: 0.24, blue: 0.26)),
    ("jet", "Jet", Color(red: 0.07, green: 0.07, blue: 0.08)),
    ("jade", "Jade", Color(red: 0.25, green: 0.56, blue: 0.42)),
    ("lapis", "Lapis", Color(red: 0.18, green: 0.37, blue: 0.70)),
    ("amber", "Amber", Color(red: 0.89, green: 0.61, blue: 0.18)),
    ("garnet", "Garnet", Color(red: 0.56, green: 0.17, blue: 0.23)),
    ("amethyst", "Amethyst", Color(red: 0.54, green: 0.36, blue: 0.79)),
    ("pebble", "Pebble", Color(red: 0.60, green: 0.58, blue: 0.56)),
    ("core", "Core", Color(red: 0.37, green: 0.77, blue: 0.84)),
    ("neon", "Neon", Color(red: 0.88, green: 0.31, blue: 0.82)),
    ("iris", "Iris", Color(red: 0.54, green: 0.59, blue: 0.64)),
  ]

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup("Mascot") {
        VStack(alignment: .leading, spacing: 10) {
          Text("Style").font(.system(size: 13, weight: .semibold))
          LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
            ForEach(Self.styles, id: \.id) { style in stone(style) }
          }
        }
        .padding(16)
        .id("mascot")
        RowDivider()
        SettingRow("Size", detail: "The change shows on the mascot at once.") {
          HStack(spacing: 8) {
            Text("Small").font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
            Slider(value: Binding(get: { size ?? model.value("mascot.size")?.number ?? 0.7 }, set: { size = $0 }),
                   in: 0.5...1.5, onEditingChanged: { editing in
                     guard !editing, let chosen = size else { return }
                     Task { await model.set("mascot.size", .number((chosen * 100).rounded() / 100)); size = nil }
                   })
              .frame(width: 160)
              .accessibilityLabel("Mascot size")
            Text("Large").font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
          }
        }
        if model.value("mascot.style")?.text == "flint" {
          RowDivider()
          SettingRow("Eye on Flint", detail: "Flint is the Chert mark. This gives it an eye in its window.") {
            SettingToggle(model: model, id: "mascot.eye", label: "Eye on Flint")
          }
        }
      }
      SettingsGroup("Cursor") {
        SettingRow("Cursor pace", detail: "Automatic moves calmly while a call or a recording shows the screen, and fast at other times.",
                   anchor: "cursor", fixedBy: fixed("cursor.pace")) {
          SettingChoice(model: model, id: "cursor.pace", label: "Cursor pace",
                        names: [("auto", "Automatic"), ("calm", "Calm"), ("fast", "Fast")], width: 220)
        }
      }
      SettingsGroup("Start") {
        SettingRow("Open ClawdTime when you log in", detail: loginNote, anchor: "login") {
          Toggle("Open ClawdTime when you log in", isOn: Binding(get: { openAtLogin }, set: setLogin))
            .toggleStyle(.switch).labelsHidden()
        }
        RowDivider()
        SettingRow("Talk and chat", detail: "Click the mascot to chat, or choose Talk under it. While ClawdTime is in front, Command-K opens the chat and Command-T starts a talk.", anchor: "shortcuts") {
          HStack(spacing: 4) { KeyCap("⌘K"); KeyCap("⌘T") }
        }
      }
      SettingsGroup("Setup") {
        SettingRow("Run setup again", detail: "Checks each step again. A step that is ready stays as it is.", anchor: "setup") {
          Button("Run setup", action: actions.runSetup).buttonStyle(SmallPill(kind: .secondary))
        }
        RowDivider()
        SettingRow("Desktop and connection", detail: "Desktop: \(MenuText.status(owner.desktop)). Connection: \(MenuText.status(owner.connection)). Stop ends setup and every process that ClawdTime started.") {
          Button { actions.stop() } label: { Label("Stop", systemImage: "stop.fill") }
            .buttonStyle(SmallPill(kind: .danger))
            .disabled(!(owner.isActive || setup.engineIsRunning))
        }
      }
    }
    .onAppear {
      openAtLogin = loginItem.isEnabled
      loginNote = loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil
    }
  }

  private func fixed(_ id: String) -> String? { model.isFixed(id) ? model.setting(id)?.variable : nil }

  private func stone(_ style: (id: String, name: String, color: Color)) -> some View {
    let chosen = model.value("mascot.style")?.text == style.id
    return Button {
      Task { await model.set("mascot.style", .text(style.id)) }
    } label: {
      HStack(spacing: 8) {
        Circle().fill(style.color)
          .overlay(Circle().strokeBorder(Color.white.opacity(0.25), lineWidth: 1))
          .frame(width: 16, height: 16)
        Text(style.name).font(.system(size: 12, weight: chosen ? .semibold : .regular))
        Spacer(minLength: 0)
        if chosen { Image(systemName: "checkmark").font(.system(size: 10, weight: .bold)).foregroundStyle(Theme.primary) }
      }
      .padding(.horizontal, 10)
      .frame(height: 32)
      .background(RoundedRectangle(cornerRadius: 9, style: .continuous).fill(chosen ? Theme.tint.opacity(0.6) : Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(chosen ? Theme.primary.opacity(0.7) : Theme.line, lineWidth: chosen ? 1.5 : 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(model.setting("mascot.style") == nil)
    .accessibilityLabel("\(style.name) mascot")
    .accessibilityAddTraits(chosen ? .isSelected : [])
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

/// A key of the keyboard, as a small cap.
struct KeyCap: View {
  var text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).font(.system(size: 11, weight: .semibold, design: .rounded))
      .padding(.horizontal, 7).frame(height: 22)
      .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

// MARK: Assistant

struct AssistantPage: View {
  @ObservedObject var model: SettingsModel
  @State private var confirming: String?
  @State private var words: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(model: SettingsModel, confirming: String? = nil) {
    self.model = model
    _confirming = State(initialValue: confirming)
  }

  static let speeds: [(value: Double, title: String)] = [(0.85, "Slower"), (1, "Normal"), (1.25, "Faster"), (1.5, "Fastest")]

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup("Voice") {
        SettingRow("Speak replies", detail: "In a talk, ClawdTime says its answers out loud. Off, it shows them only.", anchor: "voiceReplies") {
          SettingToggle(model: model, id: "voice.replies", label: "Speak replies")
        }
        RowDivider()
        SettingRow("Voice", detail: "The voice of the spoken answers. The desktop uses a new voice when it starts again.", anchor: "voice", fixedBy: fixed("voice.name")) {
          SettingChoice(model: model, id: "voice.name", label: "Voice",
                        names: (model.setting("voice.name")?.choices ?? ["alloy"]).map { ($0, $0.prefix(1).uppercased() + $0.dropFirst()) },
                        look: .menu, width: 140)
        }
        RowDivider()
        SettingRow("Speaking speed", detail: "How fast ClawdTime speaks. The change works at the next answer.", anchor: "voiceSpeed") {
          Picker("Speaking speed", selection: Binding(
            get: { model.value("voice.speed")?.number ?? 1 },
            set: { value in Task { await model.set("voice.speed", .number(value)) } })) {
            ForEach(Self.speeds, id: \.value) { Text($0.title).tag($0.value) }
          }
          .pickerStyle(.segmented).labelsHidden().frame(width: 260)
          .disabled(model.setting("voice.speed") == nil)
        }
        RowDivider()
        VStack(alignment: .leading, spacing: 8) {
          VStack(alignment: .leading, spacing: 2) {
            Text("Names to hear right").font(.system(size: 13, weight: .semibold))
            Text("Names that you say often, with a comma between them. Speech to text then writes them right.")
              .font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
          }
          HStack(spacing: 8) {
            TextField("Brightwave, Ledgerly, Stonepad", text: Binding(get: { words ?? model.value("vocabulary")?.text ?? "" }, set: { words = $0 }))
              .modifier(SettingsField())
              .onSubmit(saveWords)
              .disabled(model.isFixed("vocabulary"))
              .accessibilityLabel("Names to hear right")
            Button("Save", action: saveWords).buttonStyle(SmallPill(kind: .primary))
              .disabled(words == nil || words == model.value("vocabulary")?.text || model.work != nil)
          }
        }
        .padding(16)
        .id("vocabulary")
      }
      SettingsGroup("Memory") {
        SettingRow("Keep what I tell ClawdTime", detail: "On, ClawdTime keeps facts that you tell it, on this Mac only. It uses them in later chats and tasks.", anchor: "memory") {
          SettingToggle(model: model, id: "memory", label: "Keep what I tell ClawdTime")
        }
        RowDivider()
        SettingRow("Forget everything", detail: "Removes every fact in memory, for good. Memory stays on or off as it is.", anchor: "forget") {
          if confirming != "forget" {
            Button("Forget everything…") { withAnimation(spring) { confirming = "forget" } }.buttonStyle(SmallPill(kind: .danger))
          }
        }
        if confirming == "forget" {
          ConfirmRow(question: "Remove every fact in memory? You cannot get them back.", action: "Forget", working: model.work == .forget,
                     cancel: { withAnimation(spring) { confirming = nil } },
                     confirm: { Task { await model.forgetMemory(); withAnimation(spring) { confirming = nil } } })
        }
      }
      SettingsGroup("Away") {
        SettingRow("Away: answer by phone", detail: "When a coding agent asks a question, ClawdTime calls your phone and waits up to 9 minutes. Off, it waits 45 seconds here, then the agent asks in its terminal.", anchor: "away") {
          SettingToggle(model: model, id: "away", label: "Away: answer by phone")
        }
      }
    }
  }

  private var spring: Animation? { reduceMotion ? nil : Theme.spring }
  private func fixed(_ id: String) -> String? { model.isFixed(id) ? model.setting(id)?.variable : nil }

  private func saveWords() {
    guard let typed = words, typed != model.value("vocabulary")?.text else { return }
    Task {
      if await model.set("vocabulary", .text(typed.trimmingCharacters(in: .whitespaces))) { words = nil }
    }
  }
}

// MARK: Models

struct ModelsPage: View {
  @ObservedObject var model: SettingsModel
  var preview: SettingsPreview
  @State private var advanced: Bool
  @State private var chat: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(model: SettingsModel, preview: SettingsPreview) {
    self.model = model; self.preview = preview
    _advanced = State(initialValue: preview.advanced)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      speed
      SettingsGroup("Model keys") {
        KeysPage(model: model, editing: preview.editingKey, removing: preview.removingKey)
      }
      .id("keys")
      VStack(alignment: .leading, spacing: 12) {
        Button {
          withAnimation(reduceMotion ? nil : Theme.spring) { advanced.toggle() }
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
              .rotationEffect(.degrees(advanced ? 90 : 0))
            Text("Advanced: a model for each role").font(.system(size: 13, weight: .semibold))
          }
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(advanced ? "Hide the advanced model choices" : "Show the advanced model choices")
        if advanced {
          VStack(alignment: .leading, spacing: 14) {
            SettingsGroup("Planner: plans each step of computer use") {
              ModelPage(model: model).padding(16)
            }
            .id("planner")
            chatModel
          }
          .transition(.opacity.combined(with: .move(edge: .top)))
        }
      }
    }
  }

  @ViewBuilder private var speed: some View {
    let current = model.value("speed")?.text ?? "best"
    let presets = model.runtime?.speed.presets ?? []
    SettingsGroup("Speed") {
      VStack(alignment: .leading, spacing: 10) {
        if model.runtime == nil {
          Loading()
        } else if presets.isEmpty {
          Text("The tests of ClawdTime measured no preset for \(SettingsWords.provider(model.runtime?.speed.provider ?? "")). Choose the models in Advanced.")
            .font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        } else {
          HStack(spacing: 10) {
            ForEach(presets) { preset in card(preset, chosen: preset.id == current) }
          }
          Text(current == "custom"
               ? "Custom: you chose the models in Advanced. Choose a preset to use its models."
               : "Measured with \(SettingsWords.provider(model.runtime?.speed.provider ?? "")) models on the tests of ClawdTime. The desktop restarts to use a new preset.")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(16)
      .id("speed")
    }
  }

  private func card(_ preset: SpeedPreset, chosen: Bool) -> some View {
    Button {
      Task { await model.set("speed", .text(preset.id)) }
    } label: {
      VStack(alignment: .leading, spacing: 6) {
        HStack {
          Image(systemName: preset.id == "fast" ? "hare.fill" : preset.id == "balanced" ? "scalemass.fill" : "sparkles")
            .font(.system(size: 12, weight: .semibold))
          Text(SettingsWords.preset(preset.id)).font(.system(size: 14, weight: .semibold))
          Spacer(minLength: 0)
          Image(systemName: chosen ? "largecircle.fill.circle" : "circle")
            .font(.system(size: 13)).foregroundStyle(chosen ? Theme.primary : Theme.secondaryText)
        }
        Text(preset.summary).font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        VStack(alignment: .leading, spacing: 1) {
          Text("Plans: \(preset.planner)")
          Text("Chats: \(preset.chat)")
        }
        .font(.system(size: 10, design: .monospaced)).foregroundStyle(Theme.secondaryText).lineLimit(1).truncationMode(.middle)
      }
      .padding(12)
      .frame(maxWidth: .infinity, minHeight: 132, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(chosen ? Theme.tint.opacity(0.6) : Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(chosen ? Theme.primary.opacity(0.7) : Theme.line, lineWidth: chosen ? 1.5 : 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(model.work != nil)
    .accessibilityLabel("\(SettingsWords.preset(preset.id)): \(preset.summary)")
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }

  private var chatModel: some View {
    SettingsGroup("Chat: answers you and starts the work") {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Text("In use").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondaryText)
          Text(model.value("model.chat")?.text ?? "").font(.system(size: 13, weight: .semibold, design: .monospaced)).textSelection(.enabled)
          Spacer()
          Text(model.setting("model.chat")?.from == .store ? "Chosen here." : model.isFixed("model.chat") ? "Set in the environment." : "The default.")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
        }
        HStack(spacing: 8) {
          TextField("gpt-4.1-mini, or provider/model", text: Binding(get: { chat ?? "" }, set: { chat = $0 }))
            .modifier(SettingsField())
            .font(.system(size: 13, design: .monospaced))
            .onSubmit(saveChat)
            .disabled(model.isFixed("model.chat"))
            .accessibilityLabel("Chat model")
          Button("Use this model", action: saveChat).buttonStyle(SmallPill(kind: .primary))
            .disabled((chat ?? "").trimmingCharacters(in: .whitespaces).isEmpty || model.work != nil)
          Button("Default") { Task { await model.reset("model.chat") } }.buttonStyle(SmallPill(kind: .secondary))
            .disabled(model.setting("model.chat")?.from != .store || model.work != nil)
        }
        Text("A faster chat model answers sooner. The key of its provider must be in Model keys.")
          .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      }
      .padding(16)
    }
    .id("chat")
  }

  private func saveChat() {
    let name = (chat ?? "").trimmingCharacters(in: .whitespaces)
    guard !name.isEmpty else { return }
    Task { if await model.set("model.chat", .text(name)) { chat = nil } }
  }
}

// MARK: Model keys

struct KeysPage: View {
  @ObservedObject var model: SettingsModel
  @State private var editing: String?
  @State private var removing: String?
  @State private var key = ""
  @State private var everyProvider = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// The providers that show before "Show more": these two, and every one with a key.
  static let first: Set<String> = ["openai", "anthropic"]

  init(model: SettingsModel, editing: String? = nil, removing: String? = nil) {
    self.model = model
    _editing = State(initialValue: editing)
    _removing = State(initialValue: removing)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let report = model.keys {
        let shown = report.providers.filter {
          everyProvider || Self.first.contains($0.id) || $0.set || $0.stored || $0.id == editing || $0.id == removing
        }
        let hidden = report.providers.count - shown.count
        ForEach(Array(shown.enumerated()), id: \.element.id) { index, row in
          if index > 0 { RowDivider() }
          KeyRow(row: row, working: model.work == .key(row.id), open: editing == row.id || removing == row.id,
                 add: { open(row.id) }, remove: { withAnimation(spring) { removing = row.id; editing = nil } })
          if editing == row.id { editor(row).transition(.opacity.combined(with: .move(edge: .top))) }
          if removing == row.id { confirm(row).transition(.opacity.combined(with: .move(edge: .top))) }
        }
        if hidden > 0 || everyProvider {
          RowDivider()
          Button {
            withAnimation(spring) { everyProvider.toggle() }
          } label: {
            Label(everyProvider ? "Show fewer providers" : "Show \(hidden) more providers",
                  systemImage: everyProvider ? "chevron.up" : "chevron.down")
              .font(.system(size: 12, weight: .semibold)).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .foregroundStyle(Theme.primary)
          .padding(.horizontal, 16).padding(.vertical, 10)
        }
        RowDivider()
        VStack(alignment: .leading, spacing: 4) {
          Text("Keys stay on this Mac, in a file that only you can read. ClawdTime never shows a key again. A key from the environment wins over a stored one.")
            .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
          if let problem = report.problem {
            Label(problem, systemImage: "exclamationmark.triangle").font(.system(size: 11)).foregroundStyle(Theme.danger)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .padding(16)
      } else {
        Loading().padding(16)
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
    ConfirmRow(question: "Remove the key for \(SettingsWords.name(row))? ClawdTime stops using it.", action: "Remove",
               working: model.work == .key(row.id),
               cancel: { withAnimation(spring) { removing = nil } },
               confirm: {
                 let id = row.id
                 Task {
                   await model.removeKey(provider: id)
                   withAnimation(spring) { removing = nil }
                 }
               })
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
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text("In use").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.secondaryText)
        Text(report.name ?? "None yet").font(.system(size: 13, weight: .semibold, design: .monospaced)).textSelection(.enabled)
      }
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
  }

  private func change(_ keys: KeysReport) -> some View {
    let chosen = keys.providers.first { $0.id == provider }
    return VStack(alignment: .leading, spacing: 12) {
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
          .buttonStyle(SmallPill(kind: .primary))
          .disabled(model.work != nil || (chosen != nil && name.trimmingCharacters(in: .whitespaces).isEmpty))
      }
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

// MARK: Computer use

struct ComputerPage: View {
  @ObservedObject var model: SettingsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup {
        SettingRow("Let ClawdTime use this Mac", detail: "It clicks and types for you, and checks each action in code. Off stops a task before its next action. On starts the desktop again.", anchor: "computer") {
          SettingToggle(model: model, id: "computer", label: "Let ClawdTime use this Mac")
        }
      }
      SettingsGroup("Questions") {
        SettingRow("Ask before acting", detail: model.value("computer.ask")?.text == "never"
                   ? "ClawdTime pays, deletes and sends with no question. Stop still works, and you still type each password."
                   : "ClawdTime asks you first before it pays, deletes, sends or gives access.",
                   anchor: "ask", fixedBy: fixed("computer.ask")) {
          SettingChoice(model: model, id: "computer.ask", label: "Ask before acting",
                        names: [("risky", "Before risky actions"), ("never", "Never")], width: 250)
        }
        if model.value("computer.ask")?.text == "never" {
          Label("A page or a screen can hold words that try to lead ClawdTime. With no questions, nothing stops such an action first.", systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 11)).foregroundStyle(Theme.danger).fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 16).padding(.bottom, 12)
        }
      }
      SettingsGroup("Web pages") {
        SettingRow("Browser", detail: browserDetail, anchor: "browser", fixedBy: fixed("computer.browser")) {
          SettingChoice(model: model, id: "computer.browser", label: "Browser",
                        names: [("off", "Use the screen"), ("on", "The browser in front"), ("own", "ClawdTime's own browser")],
                        look: .menu, width: 200)
        }
      }
    }
  }

  private var browserDetail: String {
    switch model.value("computer.browser")?.text {
    case "on": "ClawdTime reads and works the page in your browser in front. macOS asks once to let it control each browser."
    case "own": "ClawdTime uses a browser of its own, with its own profile. Your browser and its sign-ins stay apart."
    default: "ClawdTime works web pages through the screen, as you do."
    }
  }

  private func fixed(_ id: String) -> String? { model.isFixed(id) ? model.setting(id)?.variable : nil }
}

// MARK: Permissions

struct PermissionsPage: View {
  @ObservedObject var model: SettingsModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsGroup {
        row("Accessibility", who: "Panel", detail: "Lets ClawdTime click and type for you.", granted: model.permissions?.panelAccessibility, pane: .accessibility)
          .id("permissions")
        RowDivider()
        row("Screen Recording", who: "Panel", detail: "Lets the panel see the screen.", granted: model.permissions?.panelScreenRecording, pane: .screenRecording)
        RowDivider()
        row("Screen Recording", who: "Capture helper", detail: "Lets ClawdTime show your screen on a call.", granted: model.permissions?.captureScreenRecording, pane: .screenRecording)
      }
      if !model.stalePermissions.isEmpty || model.permissionReset != .idle {
        stale
      }
      HStack(alignment: .top) {
        Text("In System Settings, open Privacy & Security. Turn on ClawdTime in Accessibility and in Screen & System Audio Recording. This page checks again by itself.")
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

  /// macOS holds the permission of an older build: the words and the reset.
  private var stale: some View {
    SettingsGroup {
      VStack(alignment: .leading, spacing: 10) {
        if !model.stalePermissions.isEmpty {
          Text(SettingsModel.staleWords(model.stalePermissions))
            .font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 10) {
          if !model.stalePermissions.isEmpty {
            Button(PermissionWords.resetLabel) { Task { await model.resetPermissions() } }
              .buttonStyle(SmallPill(kind: .secondary)).disabled(model.permissionReset == .running)
          }
          switch model.permissionReset {
          case .done: Text(PermissionWords.resetDone).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
          case .failed: Text(PermissionWords.resetFailed).font(.system(size: 12)).foregroundStyle(Theme.danger)
          case .idle, .running: EmptyView()
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 11)
      .frame(maxWidth: .infinity, alignment: .leading)
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

// MARK: Phone

struct PhonePage: View {
  @ObservedObject var model: SettingsModel
  var actions: SettingsActions
  @State private var confirming: String?
  @State private var wait: Double?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(model: SettingsModel, actions: SettingsActions, confirming: String? = nil) {
    self.model = model; self.actions = actions
    _confirming = State(initialValue: confirming)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup("Calls on your phone") {
        if let phone = model.phone {
          pairing(phone)
          if confirming == "unpair" {
            ConfirmRow(question: "Unpair this Mac? Calls and texts to ClawdTime on this Mac stop. The phone connection ends first.",
                       action: "Unpair", working: model.work == .unpair,
                       cancel: { withAnimation(spring) { confirming = nil } },
                       confirm: { Task { await model.unpairPhone(); withAnimation(spring) { confirming = nil } } })
          }
          RowDivider()
          SettingRow("Your number", detail: number(phone), anchor: "number") {
            if phone.owner == nil { Button("Add it", action: actions.runSetup).buttonStyle(SmallPill(kind: .secondary)) }
          }
        } else {
          Loading().padding(16)
        }
      }
      SettingsGroup("When a question waits") {
        SettingRow("Call or text me", detail: "When ClawdTime needs your answer and you do not answer in the chat, it calls you, or texts you when the call does not get through.",
                   anchor: "reach", fixedBy: fixed("reach")) {
          SettingToggle(model: model, id: "reach", label: "Call or text me")
        }
        RowDivider()
        SettingRow("Wait first", detail: "How long a question waits in the chat before the call.", fixedBy: fixed("reach.wait")) {
          HStack(spacing: 8) {
            Text(SettingsWords.seconds(wait ?? model.value("reach.wait")?.number ?? 45))
              .font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.secondaryText).frame(width: 92, alignment: .trailing)
            Slider(value: Binding(get: { wait ?? model.value("reach.wait")?.number ?? 45 }, set: { wait = ($0 / 15).rounded() * 15 }),
                   in: 0...600, onEditingChanged: { editing in
                     guard !editing, let chosen = wait else { return }
                     Task { await model.set("reach.wait", .number(chosen)); wait = nil }
                   })
              .frame(width: 150)
              .disabled(model.value("reach")?.bool == false || model.isFixed("reach.wait"))
              .accessibilityLabel("Seconds before the call")
          }
        }
        if let phone = model.phone, phone.calls != "off" {
          RowDivider()
          VStack(alignment: .leading, spacing: 4) {
            Text("Calls: \(phone.calls).").font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
            Text("Texts: \(phone.texts).").font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
          }
          .padding(16)
        }
      }
    }
    .task { await model.readPhone() }
  }

  private var spring: Animation? { reduceMotion ? nil : Theme.spring }
  private func fixed(_ id: String) -> String? { model.isFixed(id) ? model.setting(id)?.variable : nil }

  @ViewBuilder private func pairing(_ phone: PhoneReport) -> some View {
    switch phone.pairing {
    case .paired:
      SettingRow("Paired", detail: pairedDetail(phone), anchor: "pairing") {
        HStack(spacing: 8) {
          StatusTag(text: phone.connection == "running" ? "Connected" : phone.connection == "off" ? "Connection off" : "Connection unknown",
                    look: phone.connection == "running" ? .on : .neutral, symbol: phone.connection == "running" ? "checkmark" : nil)
          if confirming != "unpair" {
            Button("Unpair…") { withAnimation(spring) { confirming = "unpair" } }.buttonStyle(SmallPill(kind: .danger))
          }
        }
      }
    case .none:
      SettingRow("Not paired", detail: "Pair this Mac with the shared number to talk to ClawdTime by FaceTime and iMessage.", anchor: "pairing") {
        Button("Pair this Mac", action: actions.runSetup).buttonStyle(SmallPill(kind: .primary))
      }
    case .unusable:
      SettingRow("The pairing cannot be used", detail: "Its file is damaged. Run setup to pair this Mac again.", anchor: "pairing") {
        Button("Run setup", action: actions.runSetup).buttonStyle(SmallPill(kind: .secondary))
      }
    }
  }

  private func pairedDetail(_ phone: PhoneReport) -> String {
    let allows = phone.control == true ? "It may see the screen and act on it." : phone.view == true ? "It may see the screen. It does not act on it." : "It may not see the screen."
    return "With \(phone.origin.flatMap { URL(string: $0)?.host } ?? "the shared number"). \(allows)"
  }

  private func number(_ phone: PhoneReport) -> String {
    guard let owner = phone.owner else { return "No number yet. ClawdTime calls and texts only the number that you give it." }
    let ending = owner.ending.prefix(1).uppercased() + owner.ending.dropFirst()
    switch owner.consent {
    case "yes": return "\(ending). You allowed calls and texts to it."
    case "no": return "\(ending). You did not allow calls and texts to it."
    default: return "\(ending). Calls and texts wait for your yes in setup."
    }
  }
}

// MARK: Privacy

struct PrivacyPage: View {
  @ObservedObject var model: SettingsModel
  @State private var confirming: String?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(model: SettingsModel, confirming: String? = nil) {
    self.model = model
    _confirming = State(initialValue: confirming)
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup("On this Mac") {
        if let privacy = model.privacy {
          ForEach(Array(privacy.items.enumerated()), id: \.element.id) { index, item in
            if index > 0 { RowDivider() }
            row(item)
          }
          RowDivider()
          HStack(spacing: 8) {
            Text(SettingsWords.tilde(privacy.folder)).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondaryText)
              .lineLimit(1).truncationMode(.middle).textSelection(.enabled)
            Spacer(minLength: 8)
            Button("Open the folder") { model.openFolder(privacy.folder) }.buttonStyle(SmallPill(kind: .secondary))
            if let logs = privacy.items.first(where: { $0.id == "logs" }), logs.exists {
              Button("Open the logs") { model.openFolder(logs.path) }.buttonStyle(SmallPill(kind: .secondary))
            }
          }
          .padding(16)
        } else {
          Loading().padding(16)
        }
      }
      .id("stored")
      SettingsGroup("History") {
        SettingRow("Delete history", detail: "Moves the chat history, the spoken replies and the step times to the Trash. Memory, keys and the record of computer requests stay.", anchor: "history") {
          if confirming != "history" {
            Button("Delete history…") { withAnimation(spring) { confirming = "history" } }.buttonStyle(SmallPill(kind: .danger))
              .disabled(model.privacy?.items.contains { $0.removable && $0.exists } == false)
          }
        }
        if confirming == "history" {
          ConfirmRow(question: "Move the history to the Trash? You can put it back from the Trash.", action: "Move to Trash",
                     working: model.work == .history,
                     cancel: { withAnimation(spring) { confirming = nil } },
                     confirm: { Task { await model.deleteHistory(); withAnimation(spring) { confirming = nil } } })
        }
      }
      Text("ClawdTime keeps no picture of the screen. To plan a step, it sends a picture of the screen to the model provider that you chose.")
        .font(.system(size: 11)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
    }
    .task { await model.readPrivacy() }
  }

  private var spring: Animation? { reduceMotion ? nil : Theme.spring }

  private func row(_ item: PrivacyReport.Item) -> some View {
    HStack(alignment: .center, spacing: 12) {
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(item.name).font(.system(size: 13, weight: .semibold))
          if item.removable { StatusTag(text: "History", look: .neutral) }
        }
        Text(item.what).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 12)
      Text(amount(item)).font(.system(size: 12).monospacedDigit()).foregroundStyle(Theme.secondaryText)
        .help(SettingsWords.tilde(item.path))
    }
    .padding(.horizontal, 16)
    .padding(.vertical, 9)
    .accessibilityElement(children: .combine)
  }

  private func amount(_ item: PrivacyReport.Item) -> String {
    guard item.exists else { return "None" }
    let unit: String
    switch item.id {
    case "chat": unit = (item.count ?? 0) == 1 ? "chat" : "chats"
    case "memory": unit = (item.count ?? 0) == 1 ? "fact" : "facts"
    case "keys": unit = (item.count ?? 0) == 1 ? "key" : "keys"
    case "voice", "logs": unit = (item.count ?? 0) == 1 ? "file" : "files"
    default: return SettingsWords.size(item.bytes)
    }
    return "\(item.count ?? 0) \(unit) · \(SettingsWords.size(item.bytes))"
  }
}

// MARK: About

struct AboutPage: View {
  @ObservedObject var model: SettingsModel
  var uninstall: UninstallModel?
  @State private var uninstalling = false

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      SettingsGroup {
        HStack(spacing: 14) {
          ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.primary)
            Image(systemName: "video.fill").font(.system(size: 18, weight: .bold)).foregroundStyle(Theme.onPrimary)
          }
          .frame(width: 44, height: 44)
          .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 3) {
            Text("ClawdTime \(model.about.app)").font(.system(size: 15, weight: .semibold))
            Text(runtimeLine).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.secondaryText).textSelection(.enabled)
          }
          Spacer()
        }
        .padding(16)
        .id("version")
      }
      SettingsGroup("Updates") {
        SettingRow("Check for updates", detail: updateLine, anchor: "update") {
          HStack(spacing: 8) {
            if model.work == .update { ProgressView().controlSize(.small) }
            if model.update?.newer == true, model.updatePage != nil {
              Button("Download") { model.openUpdatePage() }.buttonStyle(SmallPill(kind: .primary))
            }
            Button("Check now") { Task { await model.checkUpdate() } }.buttonStyle(SmallPill(kind: .secondary))
              .disabled(model.work == .update)
          }
        }
      }
      if let uninstall {
        SettingsGroup("Uninstall") {
          SettingRow("Uninstall ClawdTime", detail: "Stops ClawdTime, unpairs this Mac and moves ClawdTime and its files to the Trash. It deletes nothing.", anchor: "uninstall") {
            Button("Uninstall…") {
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
    }
  }

  private var runtimeLine: String {
    guard let runtime = model.about.runtime else { return "No runtime" }
    return "Runtime \(runtime)" + (model.about.shortCommit.map { " · commit \($0)" } ?? "")
  }

  private var updateLine: String {
    guard let update = model.update else { return "ClawdTime looks for a newer release only when you ask." }
    switch update.newer {
    case true?: return "ClawdTime \(update.latest) is out. This Mac has \(update.current)."
    case false?: return "ClawdTime \(update.current) is the newest release."
    case nil: return "The newest release is ClawdTime \(update.latest). This copy does not know its own version."
    }
  }
}
