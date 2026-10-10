import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureAgentRuntimeStartMarker,
  readAgentRuntimeStartTimeMs,
  resolveAgentRuntimeStartFile,
} from './agent-runtime-start';

describe('agent runtime start marker', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-agent-runtime-'));
  });

  afterEach(() => {
    const markerDir = path.join(workDir, 'api-proxy-logs', 'agent-runtime');
    if (fs.existsSync(markerDir)) {
      const markerPath = path.join(markerDir, 'started-at-ms');
      if (fs.existsSync(markerPath)) fs.chmodSync(markerPath, 0o644);
      fs.chmodSync(markerDir, 0o755);
    }
    const customMarkerDir = path.join(workDir, 'external-logs', 'api-proxy-logs', 'agent-runtime');
    if (fs.existsSync(customMarkerDir)) {
      const markerPath = path.join(customMarkerDir, 'started-at-ms');
      if (fs.existsSync(markerPath)) fs.chmodSync(markerPath, 0o644);
      fs.chmodSync(customMarkerDir, 0o755);
    }
    fs.rmSync(workDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('refreshes a read-only marker with the current runtime start time', () => {
    const startedAtMs = 1_700_000_000_000;
    const refreshedAtMs = startedAtMs + 1_000;
    jest.spyOn(Date, 'now').mockReturnValueOnce(startedAtMs).mockReturnValueOnce(refreshedAtMs);

    expect(ensureAgentRuntimeStartMarker(workDir)).toBe(startedAtMs);
    expect(readAgentRuntimeStartTimeMs(workDir)).toBe(startedAtMs);
    expect(ensureAgentRuntimeStartMarker(workDir)).toBe(refreshedAtMs);
    expect(readAgentRuntimeStartTimeMs(workDir)).toBe(refreshedAtMs);
    expect(fs.statSync(resolveAgentRuntimeStartFile(workDir)).mode & 0o777).toBe(0o444);
    expect(fs.statSync(path.dirname(resolveAgentRuntimeStartFile(workDir))).mode & 0o777).toBe(0o555);
  });

  it('uses the configured proxy log root for shared marker storage', () => {
    const proxyLogsDir = path.join(workDir, 'external-logs');

    expect(ensureAgentRuntimeStartMarker(workDir, proxyLogsDir)).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(proxyLogsDir, 'api-proxy-logs', 'agent-runtime', 'started-at-ms'))).toBe(true);
  });
});
