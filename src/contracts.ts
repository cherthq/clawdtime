/** Versioned boundary; omitted protocolVersion retains v1 behavior. IDs are opaque, credentials never enter response/log objects. */
export type Adapter = "claude-code" | "codex";
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
  startedAt?: number;
  endedAt?: number;
  cancelRequested?: boolean;
  threadId?: string;
  turnId?: string;
}
export interface TaskDecision {
  id: string;
  question: string;
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
      threadId?: string;
      turnId?: string;
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
  threadId?: string;
  turnId?: string;
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
    emit: (event: { phase: string }) => void,
    signal: AbortSignal,
  ): Promise<TaskWorkerResult>;
}
/** Voice is a scoped conversation capability, never native execution or screen authority. */
export interface TaskVoiceSession {
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
  mode: "local_audio" | "handset_audio_smoke";
  /** Handset smoke admission is status/end only; omitted retains existing local voice semantics. */
  instructionsAllowed?: boolean;
  callAttemptId?: string;
  permissions: { presentation: false; control: false; screen: false };
}
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
  capabilities: {
    cooperativePause: boolean;
    polling: boolean;
    nativeControl?: "none" | "browser" | "desktop";
    sharedSurface?: boolean;
    nativeCancellation?: boolean;
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
  ): Promise<{
    state:
      "accepted" | "playing" | "completed" | "cancelled" | "failed" | "unknown";
  }>;
  endCall(callId: string, effectId: string): Promise<Record<string, unknown>>;
}
export interface DevicePort {
  createLease(lease: ControlLease): Promise<void>;
  frame(lease: ControlLease): Promise<Frame>;
  action(
    lease: ControlLease,
    frame: Frame,
    action: InputAction,
    actionId: string,
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
  adapter: Adapter;
  adapterVersion: string;
  projectRoot: string;
  externalSessionId: string;
  hostId: string;
  capabilities: AgentSession["capabilities"];
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
