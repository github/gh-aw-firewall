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
    fs.rmSync(workDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('writes a read-only marker and reuses the runtime start time', () => {
    const startedAtMs = 1_700_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(startedAtMs);

    expect(ensureAgentRuntimeStartMarker(workDir)).toBe(startedAtMs);
    expect(readAgentRuntimeStartTimeMs(workDir)).toBe(startedAtMs);
    expect(ensureAgentRuntimeStartMarker(workDir)).toBe(startedAtMs);
    expect(fs.statSync(resolveAgentRuntimeStartFile(workDir)).mode & 0o777).toBe(0o444);
    expect(fs.statSync(path.dirname(resolveAgentRuntimeStartFile(workDir))).mode & 0o777).toBe(0o555);
  });

  it('uses the configured proxy log root for shared marker storage', () => {
    const proxyLogsDir = path.join(workDir, 'external-logs');

    expect(ensureAgentRuntimeStartMarker(workDir, proxyLogsDir)).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(proxyLogsDir, 'api-proxy-logs', 'agent-runtime', 'started-at-ms'))).toBe(true);
  });
});
