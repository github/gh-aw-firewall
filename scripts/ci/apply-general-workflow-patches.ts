// Ordered general-purpose transforms for a compiled workflow lock file.
// Callers remain responsible for writing content and printing the ordered log.
import type { WorkflowTransform } from './workflow-patches/types';
import {
  configureNpmFeed, normalizePreparedImages, boundRipgrepInstall,
  retryCloudHypervisorBundle, installLocalAwf,
} from './workflow-patches/network-and-install';
import { collectSessionState } from './workflow-patches/session-state';
import {
  retryCopilotInstall, gateEngineLifecycle, configureCopilotToolsAndModel,
} from './workflow-patches/engine-lifecycle';
import {
  excludeAuditorCredentials, restrictRecoveryRoots, excludeAzureCredentials,
} from './workflow-patches/credentials';
import { restrictDiagnosisCacheContext, hardenCacheMemory } from './workflow-patches/cache-memory';
import { scopeConclusionConcurrency } from './workflow-patches/concurrency';
import { declareDisabledAdmissionOutputs } from './workflow-patches/admission';
import { configureAzureSmoke } from './workflow-patches/azure-smoke';
import {
  normalizeEnclaveGatewayPolicy, configureEnclaveReadiness,
  preserveWritableMetadata, configureEnclaveDiagnostics,
} from './workflow-patches/enclave';

export { usesPublishedAwfRelease } from './workflow-patches/network-and-install';

export interface PatchResult {
  content: string;
  log: string[];
}

// Domains deliberately recur: moving stages together changes transform/log order.
const pipeline: readonly WorkflowTransform[] = [
  configureNpmFeed,
  excludeAuditorCredentials,
  normalizePreparedImages,
  declareDisabledAdmissionOutputs,
  configureAzureSmoke,
  normalizeEnclaveGatewayPolicy,
  boundRipgrepInstall,
  restrictDiagnosisCacheContext,
  restrictRecoveryRoots,
  retryCopilotInstall,
  retryCloudHypervisorBundle,
  configureEnclaveReadiness,
  installLocalAwf,
  collectSessionState,
  gateEngineLifecycle,
  scopeConclusionConcurrency,
  configureCopilotToolsAndModel,
  excludeAzureCredentials,
  hardenCacheMemory,
  preserveWritableMetadata,
  configureEnclaveDiagnostics,
];

export function applyGeneralWorkflowPatches(
  content: string,
  workflowPath: string
): PatchResult {
  const context = { workflowPath, workflowFile: workflowPath.split(/[/\\]/).pop() };
  const log: string[] = [];
  for (const transform of pipeline) {
    const result = transform(content, context);
    content = result.content;
    log.push(...result.messages);
  }
  return { content, log };
}
