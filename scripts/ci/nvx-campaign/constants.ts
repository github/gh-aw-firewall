import type { RunResult } from '../nvx-promotion-evaluator';
import type { CampaignMode, ResourceLimits } from './manifest';

export const RESOURCE_PROFILE_LIMITS: Record<RunResult['resourceProfile'], ResourceLimits> = {
  minimum: { cpuCores: 1, memoryMiB: 2048, pidsMax: 128, scratchMiB: 1024 },
  default: { cpuCores: 2, memoryMiB: 4096, pidsMax: 256, scratchMiB: 2048 },
  elevated: { cpuCores: 4, memoryMiB: 6144, pidsMax: 512, scratchMiB: 4096 },
};

export const INFRASTRUCTURE_FAILURES = new Set(['runner-preempted', 'runner-unavailable', 'network-infrastructure']);
export const EXECUTION_SAMPLE_COUNTS: Partial<Record<CampaignMode, number>> = {
  'pilot-100': 10,
  'pilot-1000': 100,
  full: 1_000,
};
