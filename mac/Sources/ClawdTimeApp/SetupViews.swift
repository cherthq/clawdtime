import AppKit
import ClawdTimeAppCore
import SwiftUI

/// What the window shows. Its key gives each screen its own transition.
enum Screen: Equatable {
  case welcome, connecting, checking
  case step(StepEvent)
  case finished(ready: Bool)
  case failed(SetupFailure)
  case stopped

  init(_ state: SetupState) {
    switch state.phase {
    case .idle: self = .welcome
    case .connecting: self = .connecting
    case .running: self = state.current.map(Screen.step) ?? .checking
    case .finished(let ready): self = .finished(ready: ready)
    case .failed(let failure): self = .failed(failure)
    case .stopped: self = .stopped
    }
  }

  var key: String {
    switch self {
    case .welcome: "welcome"
    case .connecting, .checking: "checking"
    case .step(let step): "step-\(step.id.rawValue)"
    case .finished: "finished"
    case .failed: "failed"
    case .stopped: "stopped"
    }
  }
}

/// The first-launch window: one screen per step, with Stop always in view.
struct SetupRootView: View {
  @ObservedObject var setup: SetupCoordinator
  @ObservedObject var owner: ProcessOwner
  let loginItem: LoginItemControlling
  var close: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let size = CGSize(width: 600, height: 660)

  var body: some View {
    let screen = Screen(setup.state)
    VStack(spacing: 0) {
      HeaderView(running: setup.engineIsRunning || owner.isActive, stop: { setup.stop() })
      ProgressRail(state: setup.state, visible: screen != .welcome)
        .padding(.horizontal, 32)
        .padding(.top, 4)
      ZStack {
        content(screen)
          .id(screen.key)
          .transition(transition)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .padding(.horizontal, 32)
      .padding(.top, 20)
      .animation(reduceMotion ? nil : Theme.spring, value: screen.key)
      if let warning = setup.state.warnings.last {
        Label(warning, systemImage: "exclamationmark.circle")
          .font(.system(size: 12))
          .foregroundStyle(Theme.secondaryText)
          .lineLimit(2)
          .padding(.horizontal, 32)
          .padding(.bottom, 16)
          .transition(.opacity)
      }
    }
    .frame(width: Self.size.width, height: Self.size.height)
    .background(Theme.background)
    .foregroundStyle(Theme.text)
    .tint(Theme.primary)
  }

  private var transition: AnyTransition {
    reduceMotion ? .opacity : .asymmetric(
      insertion: .offset(x: 36).combined(with: .opacity),
      removal: .offset(x: -36).combined(with: .opacity))
  }

  @ViewBuilder private func content(_ screen: Screen) -> some View {
    switch screen {
    case .welcome: WelcomeView(begin: { setup.begin() })
    case .connecting, .checking: WaitingView(title: "Checking this Mac", detail: "ClawdTime looks at what is set up already.")
    case .step(let step):
      StepCard(step: step, awaiting: setup.awaiting == step.id,
               submit: { setup.submit($0) }, perform: { setup.perform($0) },
               recover: { setup.followRecovery() })
    case .finished(let ready):
      FinishedView(state: setup.state, ready: ready, handedOff: setup.handedOff, owner: owner, loginItem: loginItem,
                   finish: { setup.finish() }, again: { setup.begin() }, close: close)
    case .failed(let failure):
      FailureView(failure: failure, again: failure.kind == .runtimeMissing ? nil : { setup.begin() })
    case .stopped:
      StoppedView(again: { setup.begin() })
    }
  }
}

struct HeaderView: View {
  var running: Bool
  var stop: () -> Void
  var body: some View {
    HStack(spacing: 10) {
      ZStack {
        Circle().fill(Theme.primary)
        Image(systemName: "video.fill").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.onPrimary)
      }
      .frame(width: 26, height: 26)
      .accessibilityHidden(true)
      Text("ClawdTime").font(.system(size: 15, weight: .semibold))
      Spacer()
      Button(action: stop) {
        Label("Stop", systemImage: "stop.fill")
      }
      .buttonStyle(PillStyle(kind: .danger))
      .disabled(!running)
      .keyboardShortcut(".", modifiers: .command)
      .help("Stop setup and every ClawdTime process on this Mac")
      .accessibilityLabel("Stop ClawdTime")
    }
    .padding(.horizontal, 24)
    .padding(.top, 40)
    .padding(.bottom, 14)
  }
}

struct ProgressRail: View {
  var state: SetupState
  var visible: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 4) {
        ForEach(state.order, id: \.self) { id in
          Capsule()
            .fill(color(for: id))
            .frame(height: 5)
            .accessibilityHidden(true)
        }
      }
      .animation(Theme.spring, value: state.order.map { state.state(of: $0) })
      Text(caption)
        .font(.system(size: 12, weight: .medium))
        .foregroundStyle(Theme.secondaryText)
        .monospacedDigit()
    }
    .opacity(visible ? 1 : 0)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(caption)
  }
  private var caption: String {
    guard let position = state.position, let current = state.current else {
      return "\(state.settledCount) of \(state.order.count) steps done"
    }
    return "Step \(position) of \(state.order.count) · \(current.displayTitle)"
  }
  private func color(for id: StepID) -> Color {
    switch state.state(of: id) {
    case .ready: Theme.primary
    case .skipped: Theme.primary.opacity(0.35)
    case .failed: Theme.danger
    case .inProgress, .needsInput: id == state.focus ? Theme.text : Theme.line
    case .pending: Theme.line
    }
  }
}

struct Card<Content: View>: View {
  @ViewBuilder var content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 14) { content }
      .padding(28)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Theme.surface))
      .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

struct WelcomeView: View {
  var begin: () -> Void
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      Text("Welcome to ClawdTime").font(.system(size: 30, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      Text("Set up ClawdTime on this Mac in a few steps. Each step says what it needs and why.")
        .font(.system(size: 15)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 12) {
        Row(symbol: "key.fill", title: "Your model key", detail: "Kept in protected storage on this Mac.")
        Row(symbol: "lock.shield.fill", title: "Your permissions", detail: "You choose what ClawdTime may see and do.")
        Row(symbol: "iphone", title: "Your phone, when you want calls", detail: "You can skip it and use ClawdTime on this Mac.")
      }
      .padding(.vertical, 6)
      Text("Stop, at the top of this window, ends setup and everything ClawdTime runs.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
      HStack {
        Spacer()
        Button("Set up ClawdTime", action: begin).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
      }
      .padding(.top, 8)
    }
  }
  struct Row: View {
    var symbol: String, title: String, detail: String
    var body: some View {
      HStack(alignment: .top, spacing: 14) {
        ZStack {
          RoundedRectangle(cornerRadius: 9, style: .continuous).fill(Theme.tint)
          Image(systemName: symbol).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.onTint)
        }
        .frame(width: 32, height: 32)
        .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text(title).font(.system(size: 14, weight: .semibold))
          Text(detail).font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
        }
      }
    }
  }
}

struct WaitingView: View {
  var title: String, detail: String
  var body: some View {
    Card {
      HStack(spacing: 12) {
        ProgressView().controlSize(.small)
        Text(title).font(.system(size: 20, weight: .semibold))
      }
      Text(detail).font(.system(size: 14)).foregroundStyle(Theme.secondaryText)
    }
  }
}

struct StateBadge: View {
  var state: StepState
  var body: some View {
    ZStack {
      Circle().fill(fill)
      switch state {
      case .inProgress: ProgressView().controlSize(.small)
      case .ready: Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.onPrimary)
      case .failed: Image(systemName: "exclamationmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.onDanger)
      case .skipped: Image(systemName: "arrow.turn.down.right").font(.system(size: 11, weight: .bold)).foregroundStyle(Theme.secondaryText)
      case .needsInput, .pending: Circle().fill(Theme.text).frame(width: 7, height: 7)
      }
    }
    .frame(width: 28, height: 28)
    .accessibilityLabel(label)
  }
  private var fill: Color {
    switch state {
    case .ready: Theme.primary
    case .failed: Theme.danger
    case .inProgress, .needsInput, .pending, .skipped: Theme.tint.opacity(0.6)
    }
  }
  private var label: String {
    switch state {
    case .pending: "Waiting"
    case .inProgress: "Working"
    case .needsInput: "Needs your answer"
    case .ready: "Ready"
    case .failed: "Needs attention"
    case .skipped: "Skipped"
    }
  }
}

/// One step: its title, detail, input, primary action and recovery.
struct StepCard: View {
  var step: StepEvent
  var awaiting: Bool
  var submit: (InputValue) -> Void
  var perform: (StepAction) -> Void
  var recover: () -> Bool

  @State private var text = ""
  @State private var selection: Set<String> = []
  @State private var recoveryRefused = false
  @State private var shownKind: StepInput.Kind?

  /// A field of another kind starts empty: a phone number never carries into the code field.
  static func clearsField(shown: StepInput.Kind?, next: StepInput.Kind?) -> Bool {
    guard let next else { return false }
    return shown != nil && shown != next
  }

  var body: some View {
    Card {
      HStack(alignment: .center, spacing: 12) {
        StateBadge(state: awaiting ? .inProgress : step.state)
        Text(step.displayTitle).font(.system(size: 22, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      }
      if let detail = step.detail, !detail.isEmpty {
        Text(detail).font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      }
      if step.state == .needsInput, let input = step.input {
        InputField(input: input, text: $text, selection: $selection, submit: send)
          .disabled(awaiting)
      }
      if recoveryRefused {
        Text("That link cannot be opened from here.").font(.system(size: 12)).foregroundStyle(Theme.danger)
      }
      actions.padding(.top, 6)
    }
    .onAppear { shownKind = step.input?.kind }
    .onChange(of: step.input?.kind) { _, next in
      if Self.clearsField(shown: shownKind, next: next) {
        text = ""
        selection = []
      }
      if next != nil { shownKind = next }
    }
  }

  private var actions: some View {
    HStack(spacing: 10) {
      if step.id.isSkippable && (step.state == .needsInput || step.state == .failed) {
        Button("Skip for now") { perform(.skip) }.buttonStyle(PillStyle(kind: .secondary)).disabled(awaiting)
      }
      if let recovery = step.recovery, step.state == .needsInput || step.state == .failed {
        Button(recovery.label) { recoveryRefused = !recover() }
          .buttonStyle(PillStyle(kind: .secondary)).disabled(awaiting)
        if recovery.action == .openSettings {
          Button("Check again") { perform(.recheck) }.buttonStyle(PillStyle(kind: .secondary)).disabled(awaiting)
        }
      }
      Spacer(minLength: 0)
      primary
    }
  }

  @ViewBuilder private var primary: some View {
    if awaiting || step.state == .inProgress {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Working").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondaryText)
      }
      .accessibilityElement(children: .combine)
    } else if step.state == .needsInput, let input = step.input {
      if input.kind == .confirm {
        Button("No") { submit(.bool(false)) }.buttonStyle(PillStyle(kind: .secondary))
        Button("Yes") { submit(.bool(true)) }.buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
      } else {
        Button("Continue", action: send)
          .buttonStyle(PillStyle(kind: .primary))
          .keyboardShortcut(.defaultAction)
          .disabled(InputRules.value(for: input, text: text, selection: selection) == nil)
      }
    } else if step.state == .failed && step.recovery?.action != .retry {
      Button("Try again") { perform(.retry) }.buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
    }
  }

  private func send() {
    guard let input = step.input, let value = InputRules.value(for: input, text: text, selection: selection) else { return }
    // The field lets go of a secret as soon as it is sent.
    if input.kind == .secret { text = "" }
    submit(value)
  }
}

/// The field for one kind of input.
struct InputField: View {
  var input: StepInput
  @Binding var text: String
  @Binding var selection: Set<String>
  var submit: () -> Void
  @FocusState private var focused: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if let prompt = input.prompt, !prompt.isEmpty {
        Text(prompt).font(.system(size: 13, weight: .medium))
      }
      field
    }
    .onAppear { focused = true }
  }

  @ViewBuilder private var field: some View {
    switch input.kind {
    case .secret:
      SecureField("Paste here", text: $text).onSubmit(submit).modifier(FieldLook()).focused($focused)
        .accessibilityLabel(input.prompt ?? "Secret")
    case .text:
      TextField("", text: $text).onSubmit(submit).modifier(FieldLook()).focused($focused)
    case .phone:
      TextField("+1 415 555 0100", text: Binding(get: { text }, set: { text = InputRules.phone($0) }))
        .textContentType(.telephoneNumber).onSubmit(submit).modifier(FieldLook()).focused($focused)
    case .code:
      TextField("123456", text: Binding(get: { text }, set: { text = InputRules.code($0) }))
        .textContentType(.oneTimeCode).font(.system(size: 20, weight: .semibold, design: .monospaced))
        .onSubmit(submit).modifier(FieldLook()).focused($focused)
    case .choice:
      VStack(spacing: 8) {
        ForEach(input.options ?? []) { option in
          ChoiceRow(option: option, chosen: selection.contains(option.id), many: input.allowsMany) {
            if input.allowsMany {
              if selection.contains(option.id) { selection.remove(option.id) } else { selection.insert(option.id) }
            } else {
              selection = [option.id]
            }
          }
        }
      }
    case .confirm:
      EmptyView()
    }
  }
}

struct FieldLook: ViewModifier {
  func body(content: Content) -> some View {
    content
      .textFieldStyle(.plain)
      .font(.system(size: 15))
      .padding(.horizontal, 14)
      .frame(height: 40)
      .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
  }
}

struct ChoiceRow: View {
  var option: InputOption
  var chosen: Bool
  var many: Bool
  var choose: () -> Void
  var body: some View {
    Button(action: choose) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: many ? (chosen ? "checkmark.square.fill" : "square") : (chosen ? "largecircle.fill.circle" : "circle"))
          .font(.system(size: 16)).foregroundStyle(chosen ? Theme.primary : Theme.secondaryText)
        VStack(alignment: .leading, spacing: 2) {
          Text(option.label).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.text)
          if let detail = option.detail, !detail.isEmpty {
            Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).multilineTextAlignment(.leading)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(12)
      .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(chosen ? Theme.tint.opacity(0.45) : Theme.background))
      .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(chosen ? Theme.primary : Theme.line, lineWidth: 1))
      .contentShape(RoundedRectangle(cornerRadius: 12))
      .animation(Theme.quick, value: chosen)
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(chosen ? .isSelected : [])
  }
}

/// The readiness view at the end, and the status view after setup.
struct FinishedView: View {
  var state: SetupState
  var ready: Bool
  var handedOff: Bool
  @ObservedObject var owner: ProcessOwner
  let loginItem: LoginItemControlling
  var finish: () -> Void
  var again: () -> Void
  var close: () -> Void
  @State private var openAtLogin = false
  @State private var loginNote: String?

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text(ready ? "ClawdTime is ready" : "Setup is not complete").font(.system(size: 26, weight: .semibold))
      Text(ready
           ? "ClawdTime lives in the menu bar. Stop there ends sharing and control at any time."
           : "You can use what is ready now and finish the rest later.")
        .font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      ScrollView {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(state.summary) { entry in
            HStack(alignment: .top, spacing: 12) {
              StateBadge(state: entry.state).scaleEffect(0.8)
              VStack(alignment: .leading, spacing: 2) {
                Text(state.steps[entry.id]?.displayTitle ?? entry.id.fallbackTitle).font(.system(size: 13, weight: .semibold))
                if let detail = entry.detail, !detail.isEmpty {
                  Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
              }
              Spacer(minLength: 0)
            }
          }
        }
      }
      .frame(maxHeight: 250)
      if handedOff {
        VStack(alignment: .leading, spacing: 4) {
          Text("Desktop: \(MenuText.status(owner.desktop))")
          Text("Connection: \(MenuText.status(owner.connection))")
        }
        .font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
      }
      Toggle("Open ClawdTime when you log in", isOn: Binding(get: { openAtLogin }, set: setLogin))
        .toggleStyle(.switch).font(.system(size: 13))
      if let loginNote {
        Text(loginNote).font(.system(size: 12)).foregroundStyle(Theme.secondaryText)
      }
      HStack {
        Button("Run setup again", action: again).buttonStyle(PillStyle(kind: .secondary))
        Spacer()
        if handedOff {
          Button("Close", action: close).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
        } else {
          Button("Finish", action: finish).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
        }
      }
    }
    .onAppear {
      openAtLogin = loginItem.isEnabled
      loginNote = loginItem.needsApproval ? "Allow ClawdTime in System Settings, Login Items." : nil
    }
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

struct FailureView: View {
  var failure: SetupFailure
  var again: (() -> Void)?
  @State private var showDetails = false
  var body: some View {
    Card {
      HStack(spacing: 12) {
        StateBadge(state: .failed)
        Text(failure.title).font(.system(size: 22, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      }
      Text(failure.detail).font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      if !failure.details.isEmpty {
        DisclosureGroup("Details", isExpanded: $showDetails) {
          Text(failure.details.joined(separator: "\n"))
            .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondaryText)
            .textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
        }
        .font(.system(size: 12))
      }
      if let again {
        HStack {
          Spacer()
          Button("Try again", action: again).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
        }
      }
    }
  }
}

struct StoppedView: View {
  var again: () -> Void
  var body: some View {
    Card {
      HStack(spacing: 12) {
        Image(systemName: "stop.circle.fill").font(.system(size: 26)).foregroundStyle(Theme.danger)
        Text("ClawdTime is stopped").font(.system(size: 22, weight: .semibold))
      }
      Text("Setup ended, and every process ClawdTime started on this Mac is stopped. Nothing is shared.")
        .font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      HStack {
        Spacer()
        Button("Start again", action: again).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
      }
    }
  }
}
