import type { AwfFileConfig } from '../config-file';
import type { WrapperConfig } from '../types';

/**
 * Options consumed during config assembly, after config-file mapping and validation.
 * Numeric CLI arguments may still be strings; unchanged fields reuse runtime types.
 */
export interface ParsedCliOptions extends Record<string, unknown>, Omit<Partial<WrapperConfig>,
  | 'enclaves'
  | 'dnsServers'
  | 'dnsOverHttps'
  | 'upstreamProxy'
  | 'pidsLimit'
  | 'agentTimeout'
  | 'maxAiCredits'
  | 'defaultModelMultiplier'
  | 'maxModelMultiplierCap'
  | 'maxRuns'
  | 'maxPermissionDenied'
  | 'maxCacheMisses'
  | 'maxGithubApiPointsRest'
  | 'maxGithubApiPointsGraphql'
  | 'maxNumToolCalls'
> {
  keepContainers: boolean;
  workDir: string;
  dnsServers?: string;
  dnsOverHttps?: string | boolean;
  upstreamProxy?: string;
  pidsLimit?: string;
  agentTimeout?: string;
  maxAiCredits?: string | number;
  defaultModelMultiplier?: string | number;
  maxModelMultiplierCap?: string | number;
  maxRuns?: string | number;
  maxPermissionDenied?: string | number;
  maxCacheMisses?: string | number;
  home?: string;
  inputDir?: string[];
  privateHostSocketDir?: string[];
  containerWorkdir?: string;
  captureCommandOutput?: string;
  captureCommandOutputMaxBytes?: string | number;
  maxGithubApiPointsRest?: string | number;
  maxGithubApiPointsGraphql?: string | number;
  maxNumToolCalls?: string | number;
  dockerHost?: string;
  securityMode?: string;
  steeringBudget?: boolean;
  enclaves?: AwfFileConfig['enclaves'];
  chrootIdentityHome?: string;
  chrootIdentityUser?: string;
  chrootIdentityUid?: string | number;
  chrootIdentityGid?: string | number;
  dindPreStageDirs?: boolean;
  dindWorkDir?: string;
  dindStagingImage?: string;
  dindStageEngineBinaryPath?: string;
  dindStageEngineBinaryTargetPath?: string;
  cloudHypervisorPreview?: boolean;
  cloudHypervisorDevelopmentAllowUnattestedArtifacts?: boolean;
  cloudHypervisorEnclaveDebugPublic?: boolean;
  cloudHypervisorMountPolicy?: string;
  cloudHypervisorBinary?: string;
  cloudHypervisorKernel?: string;
  cloudHypervisorRootfs?: string;
  cloudHypervisorSupervisor?: string;
  cloudHypervisorArtifactManifest?: string;
  cloudHypervisorArtifactManifestBundle?: string;
  cloudHypervisorArtifactReleaseTag?: string;
  cloudHypervisorVcpus?: string | number;
  cloudHypervisorMemoryMib?: string | number;
  cloudHypervisorScratchMib?: string | number;
  cloudHypervisorApiTimeoutMs?: string | number;
  cloudHypervisorBinarySha256?: string;
  cloudHypervisorVirtiofsdSha256?: string;
  cloudHypervisorKernelSha256?: string;
  cloudHypervisorRootfsSha256?: string;
  cloudHypervisorSupervisorSha256?: string;
  nvxPreview?: boolean;
  nvxMountPolicy?: string;
  nvxLayer?: string;
  nvxArtifactManifest?: string;
  nvxArtifactManifestBundle?: string;
  nvxSignerWorkflow?: string;
  nvxOpenvmm?: string;
  nvxKernel?: string;
  nvxInitramfs?: string;
  nvxMemoryMib?: string | number;
  nvxMemoryMaxBytes?: string | number;
  nvxPidsMax?: string | number;
  nvxScratchBytes?: string | number;
}
