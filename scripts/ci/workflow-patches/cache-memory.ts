import type { PatchContext, TransformResult } from './types';
import {
  updateCacheSetupScriptRegex, setupCacheMemoryStepRegex,
  stripExecBitsStepSentinel, cacheMemoryCommitStepRegex,
  scanInjectionStepSentinel, createCacheDirStepRegex,
  cacheDateStepSentinel, cacheMemoryKeyLineRegex,
  cacheRestoreKeyPrefixRegex, cacheDateRestoreKeySentinel,
} from './cache-memory-patterns';
import { buildStripExecBitsStep, buildScanInjectionStep, buildCacheDateStep } from '../workflow-step-builders';

const diagnosisMaintenanceCacheWorkflowLockFiles = new Set([
  'auth-doctor-updater.lock.yml',
  'ci-integration-doctor-updater.lock.yml',
  'network-doctor-updater.lock.yml',
  'runtime-enclave-doctor-updater.lock.yml',
  'self-hosted-runner-doctor-updater.lock.yml',
]);

export function restrictDiagnosisCacheContext(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  // Diagnosis-maintenance caches retain intake checkpoints and review receipts across daily runs.
  if (workflowFile !== undefined && diagnosisMaintenanceCacheWorkflowLockFiles.has(workflowFile)) {
    const rewritten = content.replace(/(^|\s)--add-dir\s+["']?\/tmp\/gh-aw\/cache-memory\/["']?(?=\s|$)/g, '$1');
    if (rewritten !== content) {
      content = rewritten;
      messages.push('  Kept persistent cache-memory out of the diagnosis updater agent context');
    }
  }
  return { content, messages };
}

export function hardenCacheMemory(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  const updateCacheSetupMatches = content.match(updateCacheSetupScriptRegex);
  if (updateCacheSetupMatches) {
    content = content.replace(updateCacheSetupScriptRegex, '$2');
    messages.push(
      `  Removed ${updateCacheSetupMatches.length} unused Setup Scripts step(s) from update_cache_memory`
    );
  }
  if (!content.includes(stripExecBitsStepSentinel)) {
    const setupMatch = content.match(setupCacheMemoryStepRegex);
    if (setupMatch) {
      const indent = setupMatch[1];
      content = content.replace(
        setupCacheMemoryStepRegex,
        (m) => m + buildStripExecBitsStep(indent)
      );
      messages.push(`  Injected 'Strip execute bits' step after cache-memory setup`);
    }
  } else {
    messages.push(`  'Strip execute bits' step already present`);
  }

  // Upgrade old scanners as well as injecting missing quarantine-based scanners.
  const scanStepNewVersion = "also match the explicit '<system>' instruction tag";
  if (!content.includes(scanInjectionStepSentinel)) {
    const commitMatch = content.match(cacheMemoryCommitStepRegex);
    if (commitMatch) {
      const indent = commitMatch[1];
      content = content.replace(
        cacheMemoryCommitStepRegex,
        (m) => buildScanInjectionStep(indent) + m
      );
      messages.push(`  Injected 'Scan cache-memory for instruction-injection' step before commit`);
    }
  } else if (!content.includes(scanStepNewVersion)) {
    const oldScanStepRegex =
      /^(\s+)- name: Scan cache-memory for instruction-injection content\n(?:\1\s[^\n]*\n)+/m;
    const oldMatch = content.match(oldScanStepRegex);
    if (oldMatch) {
      const indent = oldMatch[1];
      content = content.replace(oldScanStepRegex, buildScanInjectionStep(indent));
      messages.push(`  Updated 'Scan cache-memory for instruction-injection' step to new version`);
    }
  } else {
    messages.push(`  'Scan cache-memory for instruction-injection' step already present (new version)`);
  }

  if (workflowFile !== undefined && diagnosisMaintenanceCacheWorkflowLockFiles.has(workflowFile)) {
    const before = content;
    content = content.replace(
      /^(\s+)-\x20name:\x20Compute\x20cache-memory\x20TTL\x20date\x20key\n\1\x20\x20run:\x20echo\x20"CACHE_MEMORY_DATE=[^\n]*\n/m,
      '',
    );
    content = content.replace(/\$\{\{ env\.CACHE_MEMORY_DATE \}\}-/g, '');
    if (content !== before) {
      messages.push('  Removed the date TTL from diagnosis-maintenance cache keys');
    }
  } else {
    if (!content.includes(cacheDateStepSentinel)) {
      const createCacheMatch = content.match(createCacheDirStepRegex);
      if (createCacheMatch) {
        content = content.replace(
          createCacheDirStepRegex,
          (_m, ind, createStep, cacheStep) =>
            ind + createStep + buildCacheDateStep(ind) + cacheStep
        );
        messages.push(`  Injected 'Compute cache-memory TTL date key' step before cache action`);
      }
    } else {
      messages.push(`  'Compute cache-memory TTL date key' step already present`);
    }
    // Repair partially updated keys independently.
    if (content.includes(cacheDateStepSentinel)) {
      const beforeKeyUpdate = content;
      content = content.replace(
        cacheMemoryKeyLineRegex,
        (_m, prefix) => `${prefix}\${{ env.CACHE_MEMORY_DATE }}-\${{ github.run_id }}`
      );
      const updatedCacheKey = content !== beforeKeyUpdate;
      const beforeRestoreKeysUpdate = content;
      content = content.replace(
        cacheRestoreKeyPrefixRegex,
        (_m, prefixWithWorkflowId, newline) =>
          `${prefixWithWorkflowId}\${{ env.CACHE_MEMORY_DATE }}-${newline}`
      );
      const updatedRestoreKeys = content !== beforeRestoreKeysUpdate;
      if (updatedCacheKey || updatedRestoreKeys) {
        if (updatedCacheKey && updatedRestoreKeys) {
          messages.push(`  Updated cache key and restore-keys to include CACHE_MEMORY_DATE for 1-day TTL`);
        } else if (updatedCacheKey) {
          messages.push(`  Updated cache key to include CACHE_MEMORY_DATE for 1-day TTL`);
        } else {
          messages.push(`  Updated restore-keys to include CACHE_MEMORY_DATE for 1-day TTL`);
        }
      } else {
        messages.push(`  Cache key/restore-keys already include CACHE_MEMORY_DATE`);
      }
    } else if (content.includes(cacheDateRestoreKeySentinel)) {
      messages.push(`  Cache key/restore-keys already include CACHE_MEMORY_DATE`);
    }
  }
  return { content, messages };
}
