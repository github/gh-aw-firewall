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
  const existing = readAgentRuntimeStartTimeMs(workDir, proxyLogsDir);
  if (existing !== undefined || fs.existsSync(markerPath)) return existing;

  const markerDir = path.dirname(markerPath);
  const startedAtMs = Date.now();
  try {
    fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath, `${startedAtMs}\n`, { flag: 'wx', mode: 0o444 });
    fs.chmodSync(markerPath, 0o444);
    fs.chmodSync(markerDir, 0o555);
    return startedAtMs;
  } catch {
    return readAgentRuntimeStartTimeMs(workDir, proxyLogsDir);
  }
}
