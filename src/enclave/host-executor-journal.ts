import * as fs from 'fs';
import * as path from 'path';
import type { HostExecutorRunState } from './host-executor-server';
import { HOST_EXECUTOR_ID_PATTERN } from './host-executor-protocol';
import {
  hostExecutorJournalDirectory, prepareDirectory, persist,
} from './host-executor-journal-shared';

/**
 * Permanent run tombstone and append-only lifecycle log. An existing run is
 * never resumed, even if its last write was torn or it closed successfully.
 * No payload, credential, capability or result is persisted.
 */
export class HostExecutorJournal {
  private readonly file: string;

  constructor(run: HostExecutorRunState) {
    if (!HOST_EXECUTOR_ID_PATTERN.test(run.runId)) throw new Error('Invalid host executor run identity');
    const directory = hostExecutorJournalDirectory(run);
    prepareDirectory(directory);
    this.file = path.join(directory, `${run.runId}.journal`);
    persist(this.file, { version: 1, runId: run.runId, state: 'open' }, true);
  }

  record(value: {
    invocationId?: string;
    entryId?: string;
    admissionId?: string;
    requestHash?: string;
    state: string;
    cancelGeneration?: number;
    outcome?: string;
    resultDigest?: string;
  }): void {
    const fd = fs.openSync(this.file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600) {
        throw new Error('Unsafe host executor tombstone');
      }
      fs.writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }
}

// Preserve the original journal module's public API for existing callers.
export {
  HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY, HOST_EXECUTOR_STORAGE_ROOT,
  hostExecutorJournalDirectory, hostExecutorStorageDirectory, hostExecutorVmRunId,
  prepareDirectory, persist,
} from './host-executor-journal-shared';

export {
  type HostExecutorControlPhase,
  HostExecutorControlDiagnostics,
  HostExecutorInvocationDiagnostics,
  persistHostExecutorProxyUsage,
  persistHostExecutorProxyResponseDiagnostics,
  persistHostExecutorProxyDebugDiagnostics,
  readHostExecutorInvocationDiagnostics,
} from './host-executor-diagnostics';
export {
  HostExecutorResourceJournal,
  reapHostExecutorResources,
} from './host-executor-resource-journal';
