export interface RetentionEvidence {
  version: 1;
  capability: "clawdtime-retention-v1";
  pid: number;
  startedAt: string;
  execPath: string;
  nodeHash: string;
  nodeVersion: string;
  configHash: string;
  guardHash: string;
  providerRoot: string;
  commandHash: string;
  processCommandHash: string;
  installedAt: number;
}
export interface RetentionConfig {
  version: 1;
  providerRoot: string;
  chertHome: string;
  projectId: string;
  lineId: string;
  receiptDirectory: string;
}
export function inspectPinnedProvider(providerRoot: string): {
  version: string;
  providerRoot: string;
  commandHash: string;
};
export function readRetentionConfig(path: string): RetentionConfig;
export function readRetentionEvidence(
  configFile: string,
  pid: number,
): RetentionEvidence;
export function installProviderRetention(configFile: string): RetentionEvidence;
export function processIdentity(pid?: number): {
  pid: number;
  startedAt: string;
};
export function privateJSON(path: string): unknown;
export function sha256(value: string | Uint8Array): string;
export const RETENTION_PIN: {
  version: string;
  nodeVersion: string;
  nodeSha256: string;
  files: Readonly<Record<string, string>>;
};

export function authorizeRetentionBinding(
  configFile: string,
  pid: number,
  scope: {
    project_id: string;
    line_id: string;
    binding_id: string;
    session_mode: string;
  },
): void;
export function assertRetainedJournalsClean(configFile: string): void;

export function mappedNodeExecutable(pid: number): string;
