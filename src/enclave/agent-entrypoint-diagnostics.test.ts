import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const entrypoint = path.join(
  __dirname,
  '..',
  '..',
  'containers',
  'enclave',
  'agent-entrypoint.py',
);

const harness = String.raw`
import errno
import importlib.util
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("agent_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root = Path(os.environ["HARNESS_ROOT"])
scenario = os.environ["SCENARIO"]
module.SEED_DIR = root / "seed"
module.TASK_PATH = root / "task.txt"
module.SCHEMA_PATH = root / "schema.json"
module.OUT_PATH = root / "out"
module.SESSION_LOG_PATH = root / "session.jsonl"
module.AGENT_DIR = root / "agent"
module.TEMP_DIR = root / "tmp"
module.SHARED_MEMORY_DIR = root / "shm"
module.COPILOT_BIN = str(root / "copilot")

if scenario == "bounds":
    module.SESSION_LOG_PATH.write_text("", encoding="utf-8")
    completed = module.subprocess.CompletedProcess(
        [],
        1,
        ("é" * module.MAX_TRANSCRIPT_BYTES).encode("utf-8"),
        b"x" * module.MAX_TRANSCRIPT_BYTES,
    )
    module.append_engine_result(completed)
    for index in range(10):
        module.append_event({
            "event": "large",
            "index": index,
            "value": "é" * (module.MAX_TRANSCRIPT_BYTES // 8),
        })
    transcript = module.SESSION_LOG_PATH.read_text(encoding="utf-8")
    print(json.dumps({
        "exitCode": 0,
        "transcript": transcript,
        "transcriptBytes": len(transcript.encode("utf-8")),
        "output": "",
    }))
    raise SystemExit(0)

module.SEED_DIR.mkdir()
module.AGENT_DIR.mkdir()
module.TEMP_DIR.mkdir()
module.SHARED_MEMORY_DIR.mkdir()
module.TASK_PATH.write_text(os.environ["PRIVATE_TASK"], encoding="utf-8")
module.SCHEMA_PATH.write_text('{"type":"boolean"}', encoding="utf-8")
module.OUT_PATH.write_text("", encoding="utf-8")
module.SESSION_LOG_PATH.write_text("", encoding="utf-8")

if scenario != "missing-copilot":
    copilot = Path(module.COPILOT_BIN)
    if scenario == "timeout":
        copilot.write_text("#!/bin/sh\nsleep 30 &\nwait\n", encoding="utf-8")
    elif scenario == "stdout-only":
        copilot.write_text("#!/bin/sh\nprintf '%s\\n' true\n", encoding="utf-8")
    else:
        copilot.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' 'protected conversational output'\n"
            "printf '%s' true > '" + str(module.OUT_PATH) + "'\n"
            "printf '%s\\n' 'Authorization: Bearer " + os.environ["TEST_API_TOKEN"] + "' >&2\n",
            encoding="utf-8",
        )
    copilot.chmod(0o644 if scenario == "non-executable-copilot" else 0o755)

if scenario == "missing-seed":
    module.SEED_DIR.rmdir()

if scenario == "launch-oserror":
    def fail_launch(*args, **kwargs):
        log_dir = module.AGENT_DIR / "copilot-logs"
        log_dir.mkdir(exist_ok=True)
        (log_dir / "launch.log").write_text(
            "Proxy-Authorization: Bearer " + os.environ["TEST_API_TOKEN"],
            encoding="utf-8",
        )
        raise FileNotFoundError(
            errno.ENOENT,
            "unsafe detail " + os.environ["PRIVATE_PATH"],
            os.environ["PRIVATE_PATH"],
        )
    module.subprocess.Popen = fail_launch

exit_code = module.main()
transcript = module.SESSION_LOG_PATH.read_text(encoding="utf-8")
print(json.dumps({
    "exitCode": exit_code,
    "transcript": transcript,
    "transcriptBytes": len(transcript.encode("utf-8")),
    "output": module.OUT_PATH.read_text(encoding="utf-8"),
}))
`;

interface HarnessResult {
  exitCode: number;
  transcript: string;
  transcriptBytes: number;
  output: string;
}

function runHarness(scenario: string): HarnessResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-entrypoint-'));
  try {
    const result = spawnSync('python3', ['-c', harness], {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ENTRYPOINT: entrypoint,
        HARNESS_ROOT: root,
        SCENARIO: scenario,
        PRIVATE_TASK: 'private prompt sentinel',
        PRIVATE_PATH: '/private/repository/secret-path',
        TEST_API_TOKEN: 'test-secret-token-value',
        AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
        AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: '1024',
        AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: scenario === 'timeout' ? '1' : '5',
        AWF_ENCLAVE_AGENT_MODEL: 'test-model',
      },
    });
    if (result.status !== 0) {
      throw new Error(`Python harness failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as HarnessResult;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function events(result: HarnessResult): Array<Record<string, unknown>> {
  return result.transcript.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('enclave agent protected entrypoint diagnostics', () => {
  it.each<[string, string, boolean]>([
    ['missing-copilot', 'not-found', false],
    ['non-executable-copilot', 'not-executable', true],
  ])('fails preflight safely for %s', (scenario, category, exists) => {
    const result = runHarness(scenario);
    const transcript = events(result);

    expect(result.exitCode).toBe(24);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'preflight',
      path: 'copilot-executable',
      exists,
    }));
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'operation-error',
      operation: 'preflight-copilot-executable',
      category,
    }));
    expect(transcript[transcript.length - 1])
      .toEqual({ event: 'failure', category: 'engine-failed' });
  });

  it('identifies a missing working directory without logging its path', () => {
    const result = runHarness('missing-seed');
    const transcript = events(result);

    expect(result.exitCode).toBe(24);
    expect(transcript).toContainEqual({
      event: 'preflight',
      path: 'seed-directory',
      exists: false,
      type: 'missing',
    });
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'operation-error',
      operation: 'preflight-seed-directory',
      category: 'not-found',
      errno: 2,
    }));
    expect(result.transcript).not.toContain('/private/');
  });

  it('records a redacted actionable launch OSError and existing Copilot diagnostics', () => {
    const result = runHarness('launch-oserror');
    const transcript = events(result);

    expect(result.exitCode).toBe(24);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'operation-error',
      operation: 'engine-launch',
      exception: 'FileNotFoundError',
      category: 'not-found',
      errno: 2,
      strerror: expect.any(String),
    }));
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'engine-diagnostics',
      log: expect.stringContaining('[REDACTED]'),
    }));
    expect(result.transcript).not.toContain('test-secret-token-value');
    expect(result.transcript).not.toContain('/private/repository/secret-path');
  });

  it('records the successful milestone sequence without duplicating private input', () => {
    const result = runHarness('success');
    const transcript = events(result);
    const stages = transcript
      .filter((event) => event.event === 'progress')
      .map((event) => event.stage);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('true');
    expect(stages).toEqual([
      'configuration-accepted',
      'input-accepted',
      'runtime-paths-ready',
      'preflight-completed',
      'engine-launch-attempt',
      'engine-started',
      'engine-completed',
      'output-normalization-started',
      'output-normalized',
      'output-write-attempt',
      'output-written',
    ]);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'resource-snapshot',
      stage: 'before-engine',
      filesystems: expect.arrayContaining([
        expect.objectContaining({
          path: 'agent-directory',
          capacityBytes: expect.any(Number),
          availableBytes: expect.any(Number),
        }),
        expect.objectContaining({
          path: 'shared-memory',
          capacityBytes: expect.any(Number),
          availableBytes: expect.any(Number),
        }),
      ]),
      directories: expect.arrayContaining([
        expect.objectContaining({
          path: 'agent-directory',
          entries: expect.any(Number),
          bytes: expect.any(Number),
          largestFileBytes: expect.any(Number),
          truncated: false,
        }),
      ]),
      memory: expect.any(Object),
    }));
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'resource-snapshot',
      stage: 'after-engine',
    }));
    expect(result.transcript).not.toContain('private prompt sentinel');
    expect(result.transcript).not.toContain('test-secret-token-value');
  });

  it('rejects conversational stdout when the finite result channel is empty', () => {
    const result = runHarness('stdout-only');
    const transcript = events(result);

    expect(result.exitCode).toBe(30);
    expect(result.output).toBe('');
    expect(transcript).toContainEqual({
      event: 'failure',
      category: 'result-write-failed',
    });
    expect(result.transcript).not.toContain('test-model');
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'engine-result',
      exitCode: 0,
      stdout: 'true',
      stderr: '',
    }));
    expect(transcript[transcript.length - 1]).toEqual({
      event: 'failure',
      category: 'result-write-failed',
    });
  });

  it('kills the launched process group and records a bounded deadline failure', () => {
    const started = Date.now();
    const result = runHarness('timeout');
    const transcript = events(result);

    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.exitCode).toBe(20);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'engine-result',
      exitCode: null,
    }));
    expect(transcript[transcript.length - 1])
      .toEqual({ event: 'failure', category: 'deadline-exceeded' });
  });

  it('keeps the protected transcript at its byte limit with valid JSONL', () => {
    const result = runHarness('bounds');

    const transcript = events(result);

    expect(result.transcriptBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'engine-result',
      exitCode: 1,
    }));
  });
});
