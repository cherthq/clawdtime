export interface LocalOwnershipEvidence {
  version: 1;
  attemptId: string;
  lineId: string;
  incomingBindingId: string;
  phase: "outbound_reserved";
  release: { state: "released"; retained: 0; offset: number };
  cursorBefore?: { sequence: number; eventId: string };
  cursorAfter?: { sequence: number; eventId: string };
  byorReceipts?: ByorReceiptEvidence;
  unresolvedEffects: 0;
  activeCalls: 0;
  activeCaptures: 0;
  localStop: false;
  checkedAt: number;
}
export interface LocalLineEvidence {
  source: "operator_verified_native";
  checkedAt: number;
  attemptId: string;
  lineId: string;
  incomingBindingId: string;
  idle: true;
  exclusiveOwner: true;
  identityVerified: true;
  cursorPreserved: true;
  cleanupClear: true;
  audioReady: boolean;
  videoReady: boolean;
}
export function transportReadiness(
  line: Record<string, unknown>,
  worker: Record<string, unknown>,
  now: number,
): { audioReady: boolean; videoReady: boolean };
export class LocalLineReadiness {
  constructor(
    config: {
      callsOrigin: string;
      projectId: string;
      projectKey: string;
      connectorToken?: string;
      incomingHost?: { program: "chert-dev"; version: string };
      lineId: string;
    },
    ports: {
      readLocalEvidence(): LocalOwnershipEvidence;
      request?: typeof fetch;
      clock?: () => number;
    },
  );
  inspect(attemptId: string): Promise<LocalLineEvidence>;
}

export interface ByorReceiptEvidence {
  kind: "byor_v2";
  scopeFingerprint: string;
  beforeDigest: string;
  afterDigest: string;
  beforeReceiptCount: number;
  afterReceiptCount: number;
  appendOnly: true;
  retained: 0;
  originalPresent: true;
}
export function createByorReceiptWitness(
  path: string,
  expectedScope: {
    project_id: string;
    line_id: string;
    binding_id: string;
    binding_epoch: number;
    instance_id: string;
  },
): { inspect(): ByorReceiptEvidence };
export function assertIncomingReleaseSupported(host: {
  program: "chert-dev";
  version: string;
}): never;
