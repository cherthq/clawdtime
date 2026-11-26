import type {
  CameraSelection,
  CameraCommand,
  CameraFrame,
  CameraStatus,
  CameraReceipt,
  PresentationReference,
} from "./camera-contracts.js";
/** Versioned boundary; omitted protocolVersion retains v1 behavior. IDs are opaque, credentials never enter response/log objects. */
export type Adapter = "claude-code" | "codex" | "audio-qualification";
/** Dedicated, immutable, short-lived audio-only authority. Never grants execution. */
export interface AudioQualification {
  version: 1;
  executionDisabled: true;
  expiresAt: number;
}
/** Independent-task v1 is separate from legacy original-chat AgentSession authority. */
export interface IndependentTaskSession {
  id: string;
  version: 1;
  pairingId: string;
  memberId: string;
  deviceId: string;
  hostId: string;
  projectRoot: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  permissions: {
    execute: true;
    voice: boolean;
    presentation: false;
    control: false;
  };
}
export type CodingTaskState =
  | "queued"
  | "running"
  | "verifying"
  | "needs_decision"
  | "walkthrough_ready"
  | "in_call"
  | "review_ready"
  | "review_call"
  | "accepted"
  | "blocked"
  | "canceled"
  | "failed"
  | "unknown";
export interface CodingRun {
  id: string;
  instruction: string;
  dispatchId: string;
  state:
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "blocked"
    | "canceled"
    | "unknown";
  summary?: string;
  decision?: string;
  decisionOptions?: string[];
  startedAt?: number;
  endedAt?: number;
  cancelRequested?: boolean;
  threadId?: string;
  turnId?: string;
  reasonCode?: string;
  outcomeHistory?: Array<{
    state: CodingRun["state"];
    at: number;
    reason?: string;
  }>;
  progress?: { phase: string; at: number };
}
export interface TaskDecision {
  id: string;
  question: string;
  options?: string[];
  runId: string;
  answer?: string;
  eventId?: string;
}
export interface TaskVerification {
  id: string;
  runId: string;
  state: "passed" | "failed" | "blocked" | "unknown";
  checks: Array<{
    name: string;
    command: string[];
    state: "passed" | "failed" | "blocked" | "unknown";
    exitCode: number | null;
    summary: string;
  }>;
  completedAt: number;
}
export interface TaskCall {
  id: string;
  runId: string;
  kind: "decision" | "review";
  state: "prepared" | "connected" | "ended" | "unanswered" | "unknown";
  opening: string;
  simulated: boolean;
}
export interface CodingTask {
  id: string;
  sessionId: string;
  revision: number;
  goal: string;
  projectRoot: string;
  state: CodingTaskState;
  runs: CodingRun[];
  decision?: TaskDecision;
  verification?: TaskVerification;
  call?: TaskCall;
  verifications: TaskVerification[];
  calls: TaskCall[];
  brief?: {
    runId: string;
    verificationId: string;
    kind: "decision" | "review";
    opening: string;
    question?: string;
  };
  createdAt: number;
  updatedAt: number;
}
export type TaskCommand = { eventId: string; expectedRevision: number } & (
  | { action: "claim_run"; runId: string }
  | {
      action: "run_result";
      runId: string;
      dispatchId: string;
      outcome: "completed" | "failed" | "blocked" | "canceled" | "unknown";
      summary: string;
      decision?: string;
      decisionOptions?: string[];
      threadId?: string;
      turnId?: string;
      reasonCode?: string;
    }
  | { action: "verify_result"; verification: TaskVerification }
  | {
      action: "prepare_call";
      callId: string;
      opening: string;
      simulated: boolean;
    }
  | {
      action: "call_state";
      callId: string;
      state: "connected" | "ended" | "unanswered" | "unknown";
    }
  | { action: "decide"; runId: string; instruction: string }
  | { action: "accept"; runId: string }
  | { action: "cancel" }
);
export interface TaskWorkerResult {
  outcome: "completed" | "failed" | "blocked" | "canceled" | "unknown";
  summary: string;
  decision?: string;
  decisionOptions?: string[];
  threadId?: string;
  turnId?: string;
  reasonCode?: string;
}
export interface TaskWorker {
  run(
    input: {
      taskId: string;
      runId: string;
      revision: number;
      projectRoot: string;
      context: string;
      dispatchId?: string;
    },
    emit: (event: {
      phase: string;
      threadId?: string;
      turnId?: string;
    }) => void,
    signal: AbortSignal,
  ): Promise<TaskWorkerResult>;
}
/** Voice is a scoped conversation capability, never native execution or screen authority. */
interface TaskVoiceSessionBase {
  id: string;
  taskId: string;
  sessionId: string;
  openedRunId: string;
  openedRevision: number;
  opening: string;
  providerConversationId?: string;
  createdAt: number;
  expiresAt: number;
  endedAt?: number;
}
export type TaskVoiceSession = TaskVoiceSessionBase &
  (
    | {
        mode: "local_audio" | "handset_audio_smoke";
        /** Smoke is status/end only; omitted retains historical local semantics. */
        instructionsAllowed?: boolean;
        callAttemptId?: string;
        permissions: { presentation: false; control: false; screen: false };
      }
    | {
        mode: "handset_walkthrough";
        instructionsAllowed: true;
        callAttemptId: string;
        exportGrantId: string;
        presentationId: string;
        manifestFingerprint: string;
        permissions: { presentation: true; control: false; screen: true };
      }
  );
export interface TaskVoiceInstruction {
  id: string;
  voiceSessionId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  providerConversationId: string;
  utteranceId: string;
  instruction: string;
  state: "held" | "applied";
  createdAt: number;
  appliedRunId?: string;
}
/** Explicit final review acceptance; never deployment or another coding run. */
export interface TaskVoiceAcceptance {
  id: string;
  voiceSessionId: string;
  taskId: string;
  runId: string;
  expectedRevision: number;
  providerConversationId: string;
  utteranceId: string;
  action: "accept";
  state: "accepted";
  createdAt: number;
}
export interface Pairing {
  id: string;
  memberId: string;
  recipient: string;
  conversationId: string;
  lineId: string;
  deviceId: string;
  displayId: string;
  createdAt: number;
  revokedAt?: number;
  allowView: boolean;
  allowControl: boolean;
}
export interface AgentSession {
  audioQualification?: AudioQualification;
  id: string;
  pairingId: string;
  adapter: Adapter;
  adapterVersion: string;
  projectRoot: string;
  externalSessionId: string;
  hostId: string;
  createdAt: number;
  /** Immutable for the lifetime of this exact registered session. Omitted = legacy. */
  protocolVersion?: 1 | 2;
  /** Explicit immutable opt-in; omitted sessions preserve their original delivery policy. */
  interaction?: {
    version: 1;
    commandChannel: "imessage_first";
    messageUpdates: boolean;
  };
  /** Explicit same-chat streaming voice selection; independent of execution host. */
  voiceFrontend?: { version: 1; provider: "elevenlabs" };
  /** New sessions only. A selected managed runner is distinct from this chat. */
  conversation?: {
    version: 1;
    runnerId: string;
    executionSession: "api_managed";
  };
  /** Immutable, explicitly selected local document root; never desktop input authority. */
  documentAccess?: { version: 1; readOnly: true; expiresAt: number };
  /** Explicit immutable selected surface; omitted means camera disabled. */
  screenCamera?: CameraSelection;
  capabilities: {
    cooperativePause: boolean;
    polling: boolean;
    nativeControl?: "none" | "browser" | "desktop";
    sharedSurface?: boolean;
    nativeCancellation?: boolean;
    voiceInteractionVersion?: 1;
    screenCameraVersion?: 1;
    livePresentationVersion?: 1;
    nativeActivationVersion?: 1;
  };
  state: "active" | "yielded" | "stopped";
  controlEpoch: number;
  lastSeenAt?: number;
}
export type AttentionState =
  | "requested"
  | "queued"
  | "ringing"
  | "connected"
  | "awaiting_input"
  | "response_delivered"
  | "resumed"
  | "completed"
  | "declined"
  | "unanswered"
  | "canceled"
  | "expired"
  | "disconnected"
  | "failed"
  | "unknown";
export interface AttentionRequest {
  audioQualification?: AudioQualification;
  id: string;
  sessionId: string;
  pairingId: string;
  taskId: string;
  idempotencyKey: string;
  reason: "blocker" | "decision" | "approval" | "review" | "result";
  question: string;
  createdAt: number;
  deadline: number;
  /** New requests without an explicit timeout may renew while their live session owns a healthy connected call. */
  renewWhileConnected?: boolean;
  state: AttentionState;
  callId?: string;
  responseId?: string;
  result?: string;
}
export interface CallSession {
  audioQualification?: AudioQualification;
  id: string;
  requestId: string;
  pairingId: string;
  providerCallId?: string;
  state: "prepared" | "ringing" | "connected" | "ended" | "unknown";
  remoteParticipantQualified: boolean;
  createdAt: number;
  endedAt?: number;
}
export interface HumanResponse {
  id: string;
  requestId: string;
  memberId: string;
  channel: "text" | "voice";
  sequence: number;
  text: string;
  kind: "answer" | "correction" | "approval";
  createdAt: number;
  acknowledgedAt?: number;
  acknowledgedSessionId?: string;
}
export interface ControlLease {
  cameraVersion?: 1;
  surface?: CameraSelection["surface"];
  id: string;
  requestId: string;
  sessionId: string;
  pairingId: string;
  callId: string;
  deviceId: string;
  displayId: string;
  memberId: string;
  mode: "view" | "control";
  protocolVersion?: 2;
  executor?: "none" | "native" | "clawdtime";
  executorEpoch?: number;
  policyRevision?: number;
  epoch: number;
  expiresAt: number;
  state: "active" | "released" | "revoked" | "unknown";
}
export type InputAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "scroll"; x: number; y: number; deltaY: number };
export interface Frame {
  camera?: CameraFrame;
  id: string;
  capturedAt: number;
  width: number;
  height: number;
}
export interface ActionReceipt {
  id: string;
  leaseId: string;
  frameId: string;
  state: "pending" | "submitted" | "observed" | "failed" | "unknown";
  createdAt: number;
  afterFrame?: Frame;
}
export interface EffectReceipt {
  id: string;
  kind: "call" | "message" | "end_call";
  state: "pending" | "running" | "done" | "failed" | "unknown";
  payload: Record<string, unknown>;
  result?: Record<string, unknown>;
  createdAt: number;
}
export interface Transport {
  readonly mode: "simulation" | "live";
  call(
    request: AttentionRequest,
    pairing: Pairing,
    effectId: string,
  ): Promise<{ callId: string; accepted: boolean }>;
  message(
    pairing: Pairing,
    text: string,
    effectId: string,
    /** Recheck after asynchronous preflight, immediately before provider submission. */
    beforeDispatch?: () => void,
  ): Promise<Record<string, unknown>>;
  speechStatus?(
    request: AttentionRequest,
    pairing: Pairing,
    replyId: string,
  ): Promise<{
    state:
      "accepted" | "playing" | "completed" | "cancelled" | "failed" | "unknown";
  }>;
  speak?(
    request: AttentionRequest,
    pairing: Pairing,
    replyId: string,
    text: string,
    reconcileOnly?: boolean,
    expectedRevision?: number,
  ): Promise<{
    state:
      "accepted" | "playing" | "completed" | "cancelled" | "failed" | "unknown";
  }>;
  endCall(callId: string, effectId: string): Promise<Record<string, unknown>>;
}
export interface DevicePort {
  createLease(lease: ControlLease): Promise<void>;
  frame(lease: ControlLease): Promise<Frame>;
  cameraStatus?(lease: ControlLease): Promise<CameraStatus>;
  cameraCommand?(
    lease: ControlLease,
    command: CameraCommand,
  ): Promise<CameraReceipt>;
  resolvePresentation?(
    lease: ControlLease,
    input: {
      commandId: string;
      window: import("./live-presentation-contracts.js").LivePresentationIntent["window"];
      expected: import("./live-presentation-contracts.js").LivePresentation["expected"];
      expiresAt: number;
    },
  ): Promise<unknown>;
  livePresentation?(
    lease: ControlLease,
    presentation: import("./live-presentation-contracts.js").LivePresentation,
    fingerprint: string,
  ): Promise<unknown>;
  nativePrepare?(
    lease: ControlLease,
    envelope: import("./production-native-contracts.js").ProductionNativeEnvelope,
  ): Promise<unknown>;
  nativeDispatch?(
    lease: ControlLease,
    envelope: import("./production-native-contracts.js").ProductionNativeEnvelope,
  ): Promise<unknown>;
  nativeReceipt?(
    lease: ControlLease,
    operationId: string,
    fingerprint: string,
  ): Promise<unknown>;
  action(
    lease: ControlLease,
    frame: Frame,
    action: InputAction,
    actionId: string,
    presentation?: PresentationReference,
  ): Promise<{ submitted: boolean }>;
  release(lease: ControlLease): Promise<void>;
}
export interface RequestAttentionInput {
  taskId: string;
  idempotencyKey: string;
  reason: AttentionRequest["reason"];
  question: string;
  timeoutSeconds?: number;
}
export interface SessionRegistration {
  protocolVersion?: 1 | 2;
  interaction?: AgentSession["interaction"];
  conversation?: AgentSession["conversation"];
  voiceFrontend?: AgentSession["voiceFrontend"];
  documentAccess?: AgentSession["documentAccess"];
  screenCamera?: CameraSelection;
  adapter: Adapter;
  adapterVersion: string;
  projectRoot: string;
  externalSessionId: string;
  hostId: string;
  capabilities: AgentSession["capabilities"];
}

/** Asynchronous conversation/execution boundary. Task text stays transient. */
export type JobState =
  | "queued"
  | "running"
  | "waiting_clarification"
  | "waiting_approval"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "canceled"
  | "unknown";
export interface JobBinding {
  sessionId: string;
  pairingId: string;
  memberId: string;
}
export interface JobSource {
  channel: "text" | "voice";
  eventId: string;
}
export interface DocumentRootGrant extends JobBinding {
  id: string;
  projectRoot: string;
  hostId: string;
  expiresAt: number;
  state: "active" | "revoked";
}
export interface DocumentCandidate {
  id: string;
  grantId: string;
  name: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  previewSupport: "first_page" | "none";
}
export interface DocumentSelection extends JobBinding {
  id: string;
  grantId: string;
  candidate: DocumentCandidate;
  previewJobId: string;
  previewRevision: number;
  expiresAt: number;
  sequence: number;
}
export interface DocumentOperation {
  operation: "discover" | "preview" | "prepare_transfer";
  grantId: string;
  candidate?: DocumentCandidate;
  transferId?: string;
}
export interface DocumentResult {
  operation: DocumentOperation["operation"];
  candidates?: DocumentCandidate[];
  candidate?: DocumentCandidate;
  assetId?: string;
  transferId?: string;
}
export interface JobIntent {
  instruction: string;
  kind: "file" | "desktop" | "document";
  preference: "auto" | "native" | "custom";
  /** Explicit target, never a guessed currently focused field. */
  target?: string;
  grantId?: string;
  /** Application-owned check, never executable model code. */
  verification?: { kind: "file_contains"; path: string; expected: string };
  document?: DocumentOperation;
}
export interface ExecutionResult {
  outcome: "succeeded" | "failed" | "canceled" | "unknown";
  summary: string;
  verification?: {
    verified: boolean;
    method:
      "file_read" | "ui_observation" | "document_digest" | "attachment_receipt";
    evidenceId: string;
  };
  unresolvedEffectIds: string[];
  document?: DocumentResult;
}
export interface ConversationJob extends JobBinding {
  id: string;
  version: 1;
  source: JobSource;
  runnerId: string;
  revision: number;
  instructionSequence: number;
  kind: JobIntent["kind"];
  preference: JobIntent["preference"];
  state: JobState;
  createdAt: number;
  updatedAt: number;
  dispatchId?: string;
  result?: ExecutionResult;
  /** Fixed operational labels only, no model transcript or file contents. */
  progress?: string;
}
export interface RunnerCapabilities {
  taskKinds?: JobIntent["kind"][];
  id: string;
  host:
    "codex_app_server" | "bounded_desktop" | "local_documents" | "unavailable";
  available: boolean;
  reason?: string;
  version: string;
  nativeControl: "none" | "browser" | "desktop";
  customControl: boolean;
  cancellation: "cooperative" | "none";
}
export interface RunnerRequest {
  job: ConversationJob;
  intent: JobIntent;
  projectRoot: string;
  externalSessionId: string;
}
export type RunnerEvent =
  | { type: "accepted" }
  | {
      type: "progress";
      stage: "reasoning" | "observing" | "input" | "verifying";
    }
  | { type: "waiting_approval" };
export interface ExecutionRunner {
  capabilities(binding?: JobBinding): RunnerCapabilities;
  run(
    request: RunnerRequest,
    emit: (event: RunnerEvent) => void,
    signal: AbortSignal,
  ): Promise<ExecutionResult>;
}

/** Separate authority variant; text control never fabricates a call. */
export interface TextControlGrant extends JobBinding {
  id: string;
  kind: "text_session";
  deviceId: string;
  displayId: string;
  projectRoot: string;
  surface: string;
  actions: InputAction["kind"][];
  expiresAt: number;
  policyRevision: number;
  localEnableGeneration: number;
  state: "active" | "revoked";
}

/** Setup stays with the originating agent; consent authorizes one exact test. */
export interface SetupTest {
  id: string;
  sessionId: string;
  pairingId: string;
  createdAt: number;
  expiresAt: number;
  state:
    | "awaiting_approval"
    | "approved"
    | "call_requested"
    | "verified"
    | "canceled"
    | "expired";
  invitationEffectId: string;
  /** New tests use consent already given in the originating native chat. */
  approvalMode?: "native_session";
  approvalSource?: "native_session";
  /** Retained for historical SMS-approved tests, never reused for new tests. */
  approvalCode?: string;
  /** Explicit recovery preserves the expired predecessor and its unknown receipt. */
  previousTestId?: string;
  approvedAt?: number;
  approvalEventId?: string;
  requestId?: string;
  verifiedAt?: number;
}

/** Local policy is authoritative; this is a fresh synchronized snapshot, never consent. */
export type ComputerControlPolicy =
  "view_only" | "agent_tools_only" | "agent_tools_with_fallback";
export interface ExecutionOwnership {
  id: string;
  requestId: string;
  sessionId: string;
  executor: "none" | "native" | "clawdtime";
  epoch: number;
  state: "idle" | "working" | "pending_approval" | "uncertain" | "paused";
  policyRevision?: number;
  updatedAt: number;
}

// Optional v2 display metadata; never input or approval authority.
export type {
  PresentationInput,
  PresentationReceipt,
} from "./attention/presentation.js";
