import * as fs from 'fs';
import * as path from 'path';

export const AGENT_RUNTIME_START_FILE = '/run/awf-runtime/started-at-ms';

export function resolveAgentRuntimeStartFile(workDir: string, proxyLogsDir?: string): string {
  return path.join(proxyLogsDir || workDir, 'api-proxy-logs', 'agent-runtime', 'started-at-ms');
}

export function readAgentRuntimeStartTimeMs(workDir: string, proxyLogsDir?: string): number | undefined {
  try {
    const value = Number(fs.readFileSync(resolveAgentRuntimeStartFile(workDir, proxyLogsDir), 'utf8').trim());
    return Number.isFinite(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export function ensureAgentRuntimeStartMarker(workDir: string, proxyLogsDir?: string): number | undefined {
  const markerPath = resolveAgentRuntimeStartFile(workDir, proxyLogsDir);
  const markerDir = path.dirname(markerPath);
  const startedAtMs = Date.now();
  let fileDescriptor: number | undefined;
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(markerDir, 0o700);
    try {
      fs.unlinkSync(markerPath);
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') {
        throw error;
      }
    }
    fileDescriptor = fs.openSync(
      markerPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o444,
    );
    try {
      fs.writeSync(fileDescriptor, `${startedAtMs}\n`);
    } finally {
      const openedFileDescriptor = fileDescriptor;
      fileDescriptor = undefined;
      fs.closeSync(openedFileDescriptor);
    }
    fs.chmodSync(markerPath, 0o444);
    fs.chmodSync(markerDir, 0o555);
    return startedAtMs;
  } catch {
    return readAgentRuntimeStartTimeMs(workDir, proxyLogsDir);
  }
}
