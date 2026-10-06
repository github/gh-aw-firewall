import type { WrapperConfig } from '../types';
import type { CheckResult, HostPreflightProgress, HostPreflightReason } from '../cloud-hypervisor/host-preflight-progress';

export interface EnclaveStartupChecklist {
  schemaVersion: 1;
  ready: boolean;
  checks: Record<string, [CheckResult, HostPreflightReason]>;
}

export type EnclaveStartupStage =
  | 'host-bootstrap' | 'runtime-preflight' | 'configuration' | 'enclave-preflight'
  | 'host-preflight' | 'artifact-preflight' | 'seed-staging' | 'storage-preflight'
  | 'recovery' | 'host-service'
  | 'host-network' | 'compose-config' | 'containers' | 'gateway-attach'
  | 'github-readiness' | 'gateway-contract' | 'initialize' | 'initialized'
  | 'tools-list' | 'delegation' | 'primary-agent';
export type GatewayCode =
  | 'none' | 'unknown' | 'dns-not-found' | 'dns-temporary'
  | 'connection-refused' | 'connection-timeout' | 'request-timeout' | 'network-unreachable'
  | 'host-unreachable' | 'connection-reset' | 'transport-other'
  | 'http-auth' | 'http-status' | 'backend-unavailable'
  | 'response-too-large' | 'malformed-json' | 'malformed-protocol' | 'rpc-error' | 'identity-mismatch'
  | 'tools-mismatch' | 'readiness-deadline' | 'ready';

export interface EnclaveStartupProgress {
  schemaVersion: 1;
  perspective: 'awf-host';
  stage: EnclaveStartupStage;
  readiness: 'not-attempted' | 'attempted' | 'ready';
  code: GatewayCode;
  attempts: number;
  httpStatus: number | null;
  hostPreflight?: HostPreflightProgress;
  startupChecks?: EnclaveStartupChecklist;
}

const states = new WeakMap<WrapperConfig, {
  progress: EnclaveStartupProgress;
  publish?: (progress: EnclaveStartupProgress) => void;
}>();

export function initializeEnclaveStartupProgress(
  config: WrapperConfig,
  publish?: (progress: EnclaveStartupProgress) => void,
): void {
  if (!config.enclaves?.enabled) return;
  states.set(config, {
    progress: {
      schemaVersion: 1, perspective: 'awf-host', stage: 'host-bootstrap',
      readiness: 'not-attempted', code: 'none', attempts: 0, httpStatus: null,
    },
    publish,
  });
  updateEnclaveStartupProgress(config, {});
}

export function getEnclaveStartupProgress(config: WrapperConfig): EnclaveStartupProgress | undefined {
  const progress = states.get(config)?.progress;
  return progress ? {
    ...progress,
    ...(progress.hostPreflight ? {
      hostPreflight: { ...progress.hostPreflight, checks: progress.hostPreflight.checks.map((check) => ({ ...check })) },
    } : {}),
    ...(progress.startupChecks ? {
      startupChecks: {
        ...progress.startupChecks,
        checks: Object.fromEntries(Object.entries(progress.startupChecks.checks)
          .map(([id, value]) => [id, [...value]])),
      },
    } : {}),
  } : undefined;
}

export function updateEnclaveStartupProgress(
  config: WrapperConfig,
  update: Partial<Omit<EnclaveStartupProgress, 'schemaVersion' | 'perspective'>>,
): void {
  if (!config.enclaves?.enabled) return;
  if (!states.has(config)) initializeEnclaveStartupProgress(config);
  const state = states.get(config)!;
  state.progress = { ...state.progress, ...update };
  if (update.hostPreflight) {
    const checks = { ...state.progress.startupChecks?.checks };
    for (const check of update.hostPreflight.checks) {
      checks[`${update.hostPreflight.scope}/${check.id}`] = [check.result, check.reason];
    }
    state.progress.startupChecks = {
      schemaVersion: 1,
      ready: checks['startup/readiness']?.[0] === 'passed'
        && Object.values(checks).every(([result]) => result === 'passed' || result === 'not-required'),
      checks,
    };
  }
  state.publish?.(getEnclaveStartupProgress(config)!);
}

export function assertEnclaveStartupChecklistComplete(config: WrapperConfig): void {
  if (!config.enclaves?.enabled) return;
  const checklist = states.get(config)?.progress.startupChecks;
  if (!checklist || !checklist.checks['startup/readiness'] || Object.entries(checklist.checks).some(([id, [result]]) =>
    id !== 'startup/readiness' && result !== 'passed' && result !== 'not-required')) {
    throw new Error('Enclave startup checklist has incomplete required checks; primary agent will not start');
  }
}

export function resetEnclaveStartupChecklist(config: WrapperConfig): void {
  updateEnclaveStartupProgress(config, {
    stage: 'configuration', readiness: 'not-attempted', code: 'none', attempts: 0,
    httpStatus: null, hostPreflight: undefined, startupChecks: undefined,
  });
}

export function gatewayTransportCode(error: unknown): GatewayCode {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  switch (code) {
    case 'ENOTFOUND': return 'dns-not-found';
    case 'EAI_AGAIN': return 'dns-temporary';
    case 'ECONNREFUSED': return 'connection-refused';
    case 'ETIMEDOUT': return 'connection-timeout';
    case 'ENETUNREACH': return 'network-unreachable';
    case 'EHOSTUNREACH': return 'host-unreachable';
    case 'ECONNRESET': return 'connection-reset';
    default: return 'transport-other';
  }
}
