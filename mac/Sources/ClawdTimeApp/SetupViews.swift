import AppKit
import ClawdTimeAppCore
import SwiftUI

/// What the window shows. Its key gives each screen its own transition and
/// its own fresh buttons: each question is a screen of its own.
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
    case .step(let step): step.question.map { "question-\($0)" } ?? "step-\(step.id.rawValue)"
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
  /// Get calls on your phone: the later, optional setup run.
  var phone: () -> Void = {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  static let size = CGSize(width: 600, height: 660)

  var body: some View {
    let screen = Screen(setup.state)
    VStack(spacing: 0) {
      // Stop stays available while a desktop that setup started may run.
      HeaderView(running: setup.canStop || owner.isActive, stop: { setup.stop() })
      ProgressRail(state: setup.state, visible: screen != .welcome && !setup.state.order.isEmpty)
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
    case .connecting, .checking: WaitingView(title: "Checking this Mac", detail: "Setup looks at what is ready already.")
    case .step(let step):
      StepCard(step: step, answered: setup.answered != nil && setup.answered == step.question, armDelay: setup.answerDelay,
               submit: { setup.submit($0) }, perform: { setup.perform($0) },
               recover: { setup.followRecovery() },
               reset: setup.offersPermissionReset ? { setup.resetPermissions() } : nil, resetState: setup.permissionReset)
    case .finished(let ready):
      FinishedView(state: setup.state, ready: ready, handedOff: setup.handedOff, phoneRun: setup.setupRun.phone, owner: owner, loginItem: loginItem,
                   finish: { setup.finish(chat: $0) }, again: { setup.begin(setup.setupRun) }, phone: phone, close: close)
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
      Text("ClawdTime uses your Mac for you. Type a task, or say it.")
        .font(.system(size: 15)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      VStack(alignment: .leading, spacing: 12) {
        Row(symbol: "key.fill", title: "A model key", detail: "Setup looks for your key. If it finds no key, you paste one.")
        Row(symbol: "cursorarrow.click.2", title: "Your yes to computer use", detail: "ClawdTime asks you before an action that you cannot undo.")
        Row(symbol: "lock.shield.fill", title: "Two switches in System Settings", detail: "Setup opens the page. Setup continues when the switches are on.")
      }
      .padding(.vertical, 6)
      Text("Then the chat opens. You can add calls on your phone later. Stop, at the top, ends setup and everything that ClawdTime runs.")
        .font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
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

/// One question of a step: its title, detail, input, answer buttons and
/// recovery. The window makes a new card for each question, so nothing
/// carries from one question to the next. Its buttons work after the
/// answer delay, and only once.
struct StepCard: View {
  var step: StepEvent
  /// An answer to this question went out: the card waits for the engine.
  var answered: Bool
  var armDelay: TimeInterval
  var submit: (InputValue) -> Void
  var perform: (StepAction) -> Void
  var recover: () -> Bool
  /// Reset ClawdTime permissions, while macOS holds an older build's permission. Nil: not offered.
  var reset: (() -> Void)?
  var resetState: PermissionResetState

  @State private var text = ""
  @State private var selection: Set<String> = []
  @State private var recoveryRefused = false
  @State private var shownKind: StepInput.Kind?
  @State private var armed: Bool
  @State private var showDetails = false

  init(step: StepEvent, answered: Bool, armDelay: TimeInterval, submit: @escaping (InputValue) -> Void,
       perform: @escaping (StepAction) -> Void, recover: @escaping () -> Bool,
       reset: (() -> Void)? = nil, resetState: PermissionResetState = .idle) {
    self.step = step; self.answered = answered; self.armDelay = armDelay
    self.submit = submit; self.perform = perform; self.recover = recover
    self.reset = reset; self.resetState = resetState
    _armed = State(initialValue: armDelay <= 0)
    // A choice with a default shows it chosen, so Return takes it. Never at a consent question.
    _selection = State(initialValue: Self.preselected(step))
  }

  /// Nothing on the card answers now: the answer went out, or the question just appeared.
  private var locked: Bool { answered || !armed }

  /// A question whose answer gives or refuses consent. Yes is never its
  /// default: Return does not answer it.
  static func isConsent(_ step: StepEvent) -> Bool {
    guard step.state == .needsInput, let input = step.input else { return false }
    return input.consent == true || (input.kind == .confirm && !checksSettings(step))
  }

  /// The label of the button that Return presses, or nil when Return answers nothing.
  static func defaultButton(_ step: StepEvent) -> String? {
    if step.state == .failed { return retryLabel(step) }
    guard step.state == .needsInput, step.input != nil else { return nil }
    if checksSettings(step) { return "Check again" }
    return isConsent(step) ? nil : "Continue"
  }

  /// The option that shows chosen when the question appears.
  static func preselected(_ step: StepEvent) -> Set<String> {
    guard step.state == .needsInput, let input = step.input else { return [] }
    return input.preselected
  }

  /// A field of another kind starts empty: a phone number never carries into the code field.
  static func clearsField(shown: StepInput.Kind?, next: StepInput.Kind?) -> Bool {
    guard let next else { return false }
    return shown != nil && shown != next
  }

  /// The one primary button of a failed step: the engine's retry, with its own label.
  static func retryLabel(_ step: StepEvent) -> String? {
    guard step.state == .failed else { return nil }
    return step.recovery?.action == .retry ? step.recovery?.label : "Try again"
  }

  /// What the reset of the permissions says after a click.
  static func resetNote(_ state: PermissionResetState) -> String? {
    switch state {
    case .idle: nil
    case .running: "Resetting."
    case .done: PermissionWords.resetDone
    case .failed: PermissionWords.resetFailed
    }
  }

  /// A step that waits for the person to act in System Settings. Its only
  /// answer is Check again, so it shows no Yes or No.
  static func checksSettings(_ step: StepEvent) -> Bool {
    step.state == .needsInput && step.recovery?.action == .openSettings && step.input?.kind == .confirm
  }

  var body: some View {
    Card {
      HStack(alignment: .center, spacing: 12) {
        StateBadge(state: answered ? .inProgress : step.state)
        Text(step.displayTitle).font(.system(size: 22, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
      }
      if let detail = step.detail, !detail.isEmpty {
        Text(detail).font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      }
      // Paths and other long lines stay here, closed until the person opens them.
      if let details = step.details, !details.isEmpty {
        DisclosureGroup("Details", isExpanded: $showDetails) {
          Text(details.joined(separator: "\n"))
            .font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.secondaryText)
            .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.top, 6)
        }
        .font(.system(size: 12))
      }
      if let reset {
        HStack(spacing: 10) {
          Button(PermissionWords.resetLabel, action: reset)
            .buttonStyle(PillStyle(kind: .secondary)).disabled(answered || resetState == .running)
          if let note = Self.resetNote(resetState) {
            Text(note).font(.system(size: 12)).foregroundStyle(resetState == .failed ? Theme.danger : Theme.secondaryText)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      if step.state == .needsInput, let input = step.input, !Self.checksSettings(step) {
        InputField(input: input, text: $text, selection: $selection, submit: send)
          .disabled(answered)
      }
      if recoveryRefused {
        Text("That link cannot be opened from here.").font(.system(size: 12)).foregroundStyle(Theme.danger)
      }
      actions.padding(.top, 6)
    }
    .onAppear { shownKind = step.input?.kind }
    .task {
      guard !armed else { return }
      try? await Task.sleep(nanoseconds: UInt64(armDelay * 1_000_000_000))
      armed = true
    }
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
      // Quiet, and on every step screen, also while the step runs.
      if Self.offersSkip(step) {
        Button("Skip for now") { perform(.skip) }
          .buttonStyle(.plain).font(.system(size: 13)).foregroundStyle(Theme.secondaryText)
          .disabled(locked)
          .help("Do this later. Setup goes on, and the report says how to finish it.")
      }
      // A retry is the primary button on the right; other recoveries sit here.
      if let recovery = step.recovery, recovery.action != .retry, step.state == .needsInput || step.state == .failed {
        Button(recovery.label) { recoveryRefused = !recover() }
          .buttonStyle(PillStyle(kind: .secondary)).disabled(answered)
        if recovery.action == .openSettings && !Self.checksSettings(step) {
          Button("Check again") { perform(.recheck) }.buttonStyle(PillStyle(kind: .secondary)).disabled(locked)
        }
      }
      Spacer(minLength: 0)
      primary
    }
  }

  /// Skip for now shows on every step but ready while the engine reads a
  /// skip: at a question, a failure, or a step in progress with a question id.
  static func offersSkip(_ step: StepEvent) -> Bool {
    step.id.isSkippable && step.question != nil && [.needsInput, .failed, .inProgress].contains(step.state)
  }

  /// Return presses this button only when it is the step's default.
  private func shortcut(_ label: String) -> KeyboardShortcut? {
    Self.defaultButton(step) == label ? .defaultAction : nil
  }

  @ViewBuilder private var primary: some View {
    if answered || step.state == .inProgress {
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Working").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.secondaryText)
      }
      .accessibilityElement(children: .combine)
    } else if Self.checksSettings(step) {
      Button("Check again") { perform(.recheck) }.buttonStyle(PillStyle(kind: .primary))
        .keyboardShortcut(shortcut("Check again")).disabled(locked)
    } else if step.state == .needsInput, let input = step.input {
      if input.kind == .confirm {
        Button("No") { submit(.bool(false)) }.buttonStyle(PillStyle(kind: .secondary)).disabled(locked)
        Button("Yes") { submit(.bool(true)) }.buttonStyle(PillStyle(kind: .primary)).disabled(locked)
      } else {
        Button("Continue", action: send)
          .buttonStyle(PillStyle(kind: .primary))
          .keyboardShortcut(shortcut("Continue"))
          .disabled(locked || InputRules.value(for: input, text: text, selection: selection) == nil)
      }
    } else if let label = Self.retryLabel(step) {
      Button(label) { perform(.retry) }.buttonStyle(PillStyle(kind: .primary))
        .keyboardShortcut(shortcut(label)).disabled(locked)
    }
  }

  private func send() {
    guard !locked, let input = step.input, let value = InputRules.value(for: input, text: text, selection: selection) else { return }
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

/// The readiness view at the end, and the status view after setup. A first
/// run that is ready ends on Start talking: the panel opens with the chat in
/// focus. The phone is a later step, one button away.
struct FinishedView: View {
  var state: SetupState
  var ready: Bool
  var handedOff: Bool
  /// The run that ended was Get calls on your phone.
  var phoneRun = false
  @ObservedObject var owner: ProcessOwner
  let loginItem: LoginItemControlling
  /// `chat`: open the chat in focus as the desktop starts.
  var finish: (_ chat: Bool) -> Void
  var again: () -> Void
  var phone: () -> Void = {}
  var close: () -> Void
  @State private var openAtLogin = false
  @State private var loginNote: String?

  /// The words and buttons of the end of setup.
  struct Words: Equatable {
    var title: String
    var line: String
    /// The default button, and whether it opens the chat.
    var primary: String
    var opensChat: Bool
    /// Get calls on your phone, when this Mac is not paired.
    var offersPhone: Bool
    var offersAgain: Bool
  }

  static func words(ready: Bool, handedOff: Bool, phoneRun: Bool, paired: Bool, desktopRuns: Bool) -> Words {
    if handedOff {
      return Words(title: ready ? "ClawdTime is ready" : "Setup is not complete",
                   line: "ClawdTime lives in the menu bar. Stop there ends sharing and control at any time.",
                   primary: "Close", opensChat: false, offersPhone: !paired, offersAgain: true)
    }
    if phoneRun {
      return ready
        ? Words(title: "Calls are ready", line: "Done connects this Mac. Then call the shared number from your verified phone to talk to ClawdTime.",
                primary: "Done", opensChat: false, offersPhone: false, offersAgain: false)
        : Words(title: "Calls are not set up yet", line: "ClawdTime still works on this Mac. Try again when you are ready.",
                primary: "Done", opensChat: false, offersPhone: false, offersAgain: true)
    }
    if !ready {
      return Words(title: "Setup is not complete", line: "You can use what is ready now and finish the rest later.",
                   primary: "Finish", opensChat: false, offersPhone: false, offersAgain: true)
    }
    // A desktop that runs already keeps its panel: there is no new chat to open.
    return Words(title: "ClawdTime is ready",
                 line: desktopRuns ? "ClawdTime runs on this Mac. Click the mascot to open the chat."
                   : "Start talking opens the chat. Type a task for ClawdTime, or talk to it.",
                 primary: desktopRuns ? "Done" : "Start talking", opensChat: !desktopRuns, offersPhone: !paired, offersAgain: false)
  }

  private var words: Words {
    Self.words(ready: ready, handedOff: handedOff, phoneRun: phoneRun, paired: state.reported(.pairing) == .ready || state.state(of: .pairing) == .ready,
               desktopRuns: owner.desktop == .running)
  }

  var body: some View {
    let words = self.words
    VStack(alignment: .leading, spacing: 16) {
      Text(words.title).font(.system(size: 26, weight: .semibold))
      Text(words.line)
        .font(.system(size: 14)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
      // The report takes the room the window has; a long one scrolls.
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          // The heading above says the result: the row of the ready step would repeat it.
          ForEach(state.summary.filter { $0.id != .ready }) { entry in
            HStack(alignment: .top, spacing: 10) {
              StateBadge(state: entry.state).scaleEffect(0.72).frame(width: 22, height: 22)
              VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                  Text(state.steps[entry.id]?.displayTitle ?? entry.id.fallbackTitle).font(.system(size: 13, weight: .semibold))
                  if entry.state == .skipped {
                    Text("Skipped").font(.system(size: 11)).foregroundStyle(Theme.secondaryText)
                  }
                }
                if let detail = entry.detail, !detail.isEmpty {
                  Text(detail).font(.system(size: 12)).foregroundStyle(Theme.secondaryText).fixedSize(horizontal: false, vertical: true)
                }
              }
              Spacer(minLength: 0)
            }
          }
        }
        .padding(.vertical, 2)
      }
      .frame(maxHeight: .infinity)
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
      HStack(spacing: 10) {
        if words.offersAgain {
          Button(phoneRun ? "Try again" : "Run setup again", action: again).buttonStyle(PillStyle(kind: .secondary))
        }
        if words.offersPhone {
          Button(action: phone) { Label("Get calls on your phone", systemImage: "iphone") }
            .buttonStyle(PillStyle(kind: .secondary))
            .help("Verify your phone, pair this Mac and connect it. Each step asks you first.")
        }
        Spacer()
        if handedOff {
          Button(words.primary, action: close).buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
        } else {
          Button(words.primary) { finish(words.opensChat) }.buttonStyle(PillStyle(kind: .primary)).keyboardShortcut(.defaultAction)
        }
      }
    }
    .padding(.bottom, 24)
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
