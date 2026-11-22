export interface RetainedOwnerConfig {
  callsOrigin: string;
  projectId: string;
  projectKey: string;
  connectorToken: string;
  getConnectorToken?: () => string;
  assertConfiguration?: () => void;
  lineId: string;
  hostScript: string;
  lineEnvironmentFile?: string;
  hostStateDirectory: string;
  hostSession: string;
  agentName: string;
  retentionConfigFile: string;
  providerStateDirectory: string;
  initialJournal: string;
  stateFile: string;
}
export interface RetainedOwnerPorts {
  request?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  host?: {
    inspect(): Promise<{ running: boolean; pid?: number }>;
    stop(): Promise<void>;
    start(): Promise<void>;
  };
  authorizeBinding?: (
    pid: number,
    scope: Record<string, unknown>,
  ) => Promise<void>;
  retention?: (pid: number) => Promise<{
    capability: "clawdtime-retention-v1";
    pid: number;
    [key: string]: unknown;
  }>;
}
export class RetainedProactiveLineOwner {
  constructor(config: RetainedOwnerConfig, ports?: RetainedOwnerPorts);
  readiness(): Promise<{ ready: boolean; reason?: string; checkedAt: number }>;
  acquire(attemptId: string): Promise<{ exclusive: true }>;
  verify(attemptId: string): Promise<boolean>;
  restore(attemptId: string): Promise<{ confirmed: true }>;
  diagnostics(): {
    ready: boolean;
    reason?: string;
    checkedAt: number;
    phase: string;
    attemptId?: string;
    retainedJournals: number;
  };
}

export function hasProcessAncestor(
  pid: number,
  ancestor: number,
  readParent: (pid: number) => Promise<number>,
): Promise<boolean>;
