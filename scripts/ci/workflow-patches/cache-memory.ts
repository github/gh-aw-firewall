import type { PatchContext, TransformResult } from './types';
import {
  updateCacheSetupScriptRegex, setupCacheMemoryStepRegex,
  stripExecBitsStepSentinel, cacheMemoryCommitStepRegex,
  scanInjectionStepSentinel, createCacheDirStepRegex,
  cacheDateStepSentinel, cacheMemoryKeyLineRegex,
  cacheRestoreKeyPrefixRegex, cacheDateRestoreKeySentinel,
} from './cache-memory-patterns';
import { buildStripExecBitsStep, buildScanInjectionStep, buildCacheDateStep } from '../workflow-step-builders';

const DEFAULT_INJECTION_PATTERN =
  "^(New instruction:|SYSTEM:|Ignore (all |previous |prior )instructions?:|<system>)";
// Match role tags anywhere after punctuation or whitespace, without regard to case.
const HARDENED_INJECTION_PATTERN =
  `(^|[[:space:][:punct:]])(system|assistant|developer|user)[[:space:]]*:|^(New instruction:|Ignore (all |previous |prior )instructions?:|<system>)`;

function buildHardenedScanInjectionStep(indent: string): string {
  const step = buildScanInjectionStep(indent);
  const defaultPattern = `INJECTION_PATTERN='${DEFAULT_INJECTION_PATTERN}'`;
  const grepCommand = 'grep -lE "$INJECTION_PATTERN"';
  if (!step.includes(defaultPattern) || !step.includes(grepCommand)) {
    throw new Error('Could not harden the cache-memory instruction-injection scanner');
  }
  return step
    .replace(defaultPattern, `INJECTION_PATTERN='${HARDENED_INJECTION_PATTERN}'`)
    .replace(grepCommand, 'grep -liE "$INJECTION_PATTERN"');
}

const diagnosisMaintenanceCacheWorkflowLockFiles = new Set([
  'auth-doctor-updater.lock.yml',
  'ci-integration-doctor-updater.lock.yml',
  'network-doctor-updater.lock.yml',
  'runtime-enclave-doctor-updater.lock.yml',
  'self-hosted-runner-doctor-updater.lock.yml',
]);
const diagnosisReceiptSanitizerStepName = 'Sanitize diagnosis receipts before cache persistence';

function buildDiagnosisReceiptSanitizerStep(indent: string): string {
  return `${indent}- name: ${diagnosisReceiptSanitizerStepName}\n` +
    `${indent}  id: sanitize-diagnosis-receipts\n` +
    `${indent}  if: always()\n` +
    `${indent}  run: npx tsx scripts/diagnostics/intake.ts --sanitize-receipts /tmp/gh-aw/cache-memory/diagnosis\n`;
}

function guardStepOnReceiptSanitization(content: string, stepName: string, required: boolean): string {
  const guard = "steps.sanitize-diagnosis-receipts.outcome == 'success'";
  const output: string[] = [];
  let stepLines: string[] | undefined;
  let stepIndent: string | undefined;
  let stepFound = false;
  const flushStep = (): void => {
    if (!stepLines) return;
    let conditionFound = false;
    const updatedStep = stepLines.map((line) => {
      if (!conditionFound && line.trimStart().startsWith('if: ')) {
        conditionFound = true;
        return line.includes(guard) ? line : `${line} && ${guard}`;
      }
      return line;
    });
    if (conditionFound) {
      output.push(...updatedStep);
    } else {
      const [header, ...rest] = updatedStep;
      const indent = header.slice(0, header.indexOf('-'));
      output.push(header, `${indent}  if: always() && ${guard}`, ...rest);
    }
    stepLines = undefined;
    stepIndent = undefined;
  };

  for (const line of content.split('\n')) {
    if (stepLines && stepIndent !== undefined && line.startsWith(`${stepIndent}- `)) {
      flushStep();
    }
    if (!stepLines && line.trim() === `- name: ${stepName}`) {
      stepLines = [line];
      stepIndent = line.slice(0, line.indexOf('-'));
      stepFound = true;
    } else if (stepLines) {
      stepLines.push(line);
    } else {
      output.push(line);
    }
  }
  flushStep();
  if (!stepFound && required) {
    throw new Error(`Could not find ${stepName} step to guard after receipt sanitization`);
  }
  return stepFound ? output.join('\n') : content;
}

export function restrictDiagnosisCacheContext(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  // Diagnosis-maintenance caches retain intake checkpoints and review receipts across daily runs.
  if (workflowFile !== undefined && diagnosisMaintenanceCacheWorkflowLockFiles.has(workflowFile)) {
    const rewritten = content.replace(/(^|\s)--add-dir(?:\s+|=)["']?\/tmp\/gh-aw\/cache-memory\/?["']?(?=\s|$)/g, '$1');
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
  const scanStepNewVersion = `INJECTION_PATTERN='${HARDENED_INJECTION_PATTERN}'`;
  if (!content.includes(scanInjectionStepSentinel)) {
    const commitMatch = content.match(cacheMemoryCommitStepRegex);
    if (commitMatch) {
      const indent = commitMatch[1];
      content = content.replace(
        cacheMemoryCommitStepRegex,
        (m) => buildHardenedScanInjectionStep(indent) + m
      );
      messages.push(`  Injected 'Scan cache-memory for instruction-injection' step before commit`);
    }
  } else if (!content.includes(scanStepNewVersion)) {
    const oldScanStepRegex =
      /^(\s+)- name: Scan cache-memory for instruction-injection content\n(?:\1\s[^\n]*\n)+/m;
    const oldMatch = content.match(oldScanStepRegex);
    if (oldMatch) {
      const indent = oldMatch[1];
      content = content.replace(oldScanStepRegex, buildHardenedScanInjectionStep(indent));
      messages.push(`  Updated 'Scan cache-memory for instruction-injection' step to new version`);
    }
  } else {
    messages.push(`  'Scan cache-memory for instruction-injection' step already present (new version)`);
  }

  if (workflowFile !== undefined && diagnosisMaintenanceCacheWorkflowLockFiles.has(workflowFile)) {
    if (!content.includes(diagnosisReceiptSanitizerStepName)) {
      const scanStep = content.match(/^([ \t]+)- name: Scan cache-memory for instruction-injection content\n/m);
      const commitStep = content.match(cacheMemoryCommitStepRegex);
      const anchor = scanStep ?? commitStep;
      if (!anchor && content.includes('Commit cache-memory changes')) {
        throw new Error('Could not find cache persistence anchor for diagnosis receipt sanitizer');
      }
      if (anchor) {
        content = content.replace(anchor[0], buildDiagnosisReceiptSanitizerStep(anchor[1]) + anchor[0]);
        messages.push(`  Injected diagnosis receipt sanitizer before cache persistence`);
      }
    }

    if (content.includes(diagnosisReceiptSanitizerStepName)) {
      const beforeCommitGuard = content;
      content = guardStepOnReceiptSanitization(content, 'Commit cache-memory changes', true);
      if (content !== beforeCommitGuard) {
        messages.push(`  Guarded diagnosis cache persistence on receipt sanitization`);
      }

      const beforeArtifactGuard = content;
      content = guardStepOnReceiptSanitization(content, 'Upload cache-memory data as artifact', false);
      if (content !== beforeArtifactGuard) {
        messages.push(`  Guarded diagnosis cache artifact on receipt sanitization`);
      }
    }
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
