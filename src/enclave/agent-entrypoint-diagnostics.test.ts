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
import io
import json
import os
from pathlib import Path

spec = importlib.util.spec_from_file_location("agent_entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

root = Path(os.environ["HARNESS_ROOT"])
scenario = os.environ["SCENARIO"]
os.environ["PATH"] = os.environ["TEST_PATH"]
module.SEED_DIR = root / "seed"
module.TASK_PATH = root / "task.txt"
module.SCHEMA_PATH = root / "schema.json"
module.OUT_PATH = root / "out"
module.OUTPUT_DIR = root
module.SESSION_LOG_PATH = root / "session.jsonl"
module.AGENT_DIR = root / "agent"
module.TEMP_DIR = root / "tmp"
module.SHARED_MEMORY_DIR = root / "shm"
module.STORAGE_PROBE_PATH = root / "probe.jsonl"
module.COPILOT_BIN = str(root / "copilot")
module.GITHUB_AGENT_ID_PATH = root / "github-agent-id"
module.GITHUB_BEARER_PATH = root / "github-bearer"
module.GITHUB_MCP_CONFIG_PATH = module.AGENT_DIR / "github-mcp.json"

if scenario.startswith("session-log-"):
    def fail():
        raise OSError(errno.ENOSPC, os.environ["TEST_API_TOKEN"], os.environ["PRIVATE_PATH"])
    class Handle:
        def write(self, data):
            if scenario.startswith("session-log-write"):
                fail()
        def close(self):
            if scenario in ("session-log-close", "session-log-close-from-except"):
                fail()
    class Log:
        def stat(self):
            if scenario == "session-log-stat":
                fail()
            return type("Stat", (), {"st_size": 0})()
        def open(self, mode):
            if scenario == "session-log-open":
                fail()
            return Handle()
    module.SESSION_LOG_PATH = Log()
    original_stderr = module.sys.stderr
    captured = io.StringIO()
    module.sys.stderr = captured
    if scenario == "session-log-write-operation":
        module.safe_os_error(
            OSError(errno.EACCES, os.environ["TEST_API_TOKEN"], os.environ["PRIVATE_PATH"]),
            "output-read-open",
        )
    elif scenario == "session-log-close-from-except":
        try:
            fail()
        except OSError as error:
            module.safe_os_error(error, "output-read-open")
    elif scenario == "session-log-write-failure":
        module.append_event({"event": "failure", "category": "result-empty"})
    else:
        module.append_event({"event": "success"})
    module.sys.stderr = original_stderr
    print(json.dumps({
        "exitCode": 0, "transcript": captured.getvalue(),
        "transcriptBytes": len(captured.getvalue()), "output": "",
    }))
    raise SystemExit(0)

if scenario == "github-config":
    module.AGENT_DIR.mkdir()
    module.GITHUB_AGENT_ID_PATH.write_text(
        os.environ["TEST_GITHUB_AGENT_ID"],
        encoding="ascii",
    )
    module.configure_github_mcp()
    print(json.dumps({
        "exitCode": 0,
        "transcript": module.redact_diagnostics(os.environ["TEST_GITHUB_AGENT_ID"]),
        "transcriptBytes": 0,
        "output": module.GITHUB_MCP_CONFIG_PATH.read_text(encoding="utf-8"),
    }))
    raise SystemExit(0)

if scenario == "boolean-secrets":
    os.environ["BOOLEAN_TOKEN"] = "true"
    os.environ["BOOLEAN_KEY"] = "false"
    os.environ["BOOLEAN_SECRET"] = "0"
    os.environ["BOOLEAN_CREDENTIAL"] = "1"
    os.environ["ORDINARY_TOKEN"] = "ordinary-secret"
    print(json.dumps({
        "exitCode": 0,
        "transcript": module.redact_diagnostics(
            "true false 0 1 ordinary-secret"
        ),
        "transcriptBytes": 0,
        "output": "",
    }))
    raise SystemExit(0)

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
module.OUT_PATH.chmod(0o600)
if scenario.startswith("output-alias") or scenario == "verify-io":
    module.OUTPUT_DIR = root / "output"
    module.OUTPUT_DIR.mkdir()
    module.OUT_PATH.unlink()
    (module.OUTPUT_DIR / "out").write_bytes(b"")
    module.OUT_PATH.symlink_to(module.OUTPUT_DIR / "out")
module.SESSION_LOG_PATH.write_text("", encoding="utf-8")
module.GITHUB_AGENT_ID_PATH.write_text(os.environ["TEST_GITHUB_AGENT_ID"], encoding="ascii")
module.GITHUB_BEARER_PATH.write_text("private-delegated-bearer-sentinel", encoding="ascii")

if scenario in ("injected-io", "verify-io"):
    original_operation = module.file_operation
    def injected_operation(operation, action, *, fatal=True):
        if operation != os.environ["FAULT_OPERATION"]:
            return original_operation(operation, action, fatal=fatal)
        def fail():
            raise OSError(
                int(os.environ.get("FAULT_ERRNO", str(errno.EIO))),
                "unsafe detail " + os.environ["TEST_API_TOKEN"],
                os.environ["PRIVATE_PATH"],
            )
        return original_operation(operation, fail, fatal=fatal)
    module.file_operation = injected_operation
    original_close_file = module.close_file
    def injected_close_file(handle, operation, *, fatal=True):
        if operation != os.environ.get("FAULT_OPERATION"):
            return original_close_file(handle, operation, fatal=fatal)
        handle.close()
        error = OSError(
            int(os.environ.get("FAULT_ERRNO", str(errno.EIO))),
            "unsafe detail " + os.environ["TEST_API_TOKEN"],
            os.environ["PRIVATE_PATH"],
        )
        module.safe_os_error(error, operation, fatal=fatal)
        raise error
    module.close_file = injected_close_file

original_engine_result = module.append_engine_result
def engine_result(completed):
    if scenario == "output-oversized":
        module.OUT_PATH.write_bytes(b"x" * 1025)
    elif scenario == "output-at-limit":
        module.OUT_PATH.write_bytes(b" " * 1020 + b"true")
    elif scenario == "output-invalid-utf8":
        module.OUT_PATH.write_bytes(b"\xff")
    elif scenario == "output-whitespace":
        module.OUT_PATH.write_bytes(b" \n\t ")
    elif scenario == "output-missing":
        module.OUT_PATH.unlink()
    elif scenario == "output-directory":
        module.OUT_PATH.unlink()
        module.OUT_PATH.mkdir()
    elif scenario == "output-mode":
        module.OUT_PATH.chmod(0o640)
    elif scenario == "probe-output-empty":
        module.OUT_PATH.write_bytes(b"")
    elif scenario == "output-alias-wrong":
        other = root / "other"
        other.write_bytes(b"false")
        module.OUT_PATH.unlink()
        module.OUT_PATH.symlink_to(other)
    elif scenario == "output-alias-regular":
        module.OUT_PATH.unlink()
        module.OUT_PATH.write_bytes(b"true")
    elif scenario == "output-alias-broken":
        (module.OUTPUT_DIR / "out").unlink()
    elif scenario == "output-alias-empty":
        (module.OUTPUT_DIR / "out").write_bytes(b"")
    return original_engine_result(completed)
module.append_engine_result = engine_result

if scenario != "missing-copilot":
    copilot = Path(module.COPILOT_BIN)
    if scenario == "timeout":
        copilot.write_text("#!/bin/sh\nsleep 30 &\nwait\n", encoding="utf-8")
    elif scenario == "stdout-only":
        copilot.write_text("#!/bin/sh\nprintf '%s\\n' true\n", encoding="utf-8")
    else:
        copilot.write_text(
            "#!/bin/sh\n"
            "printf '%s\\n' \"$@\" > '" + str(root / "copilot-args") + "'\n"
            "printf '%s\\n' 'protected conversational output'\n"
            "printf '%s' true > '" + str(module.OUT_PATH) + "'\n"
            "printf '%s\\n' 'Authorization: Bearer " + os.environ["TEST_API_TOKEN"] + "' >&2\n",
            encoding="utf-8",
        )
    copilot.chmod(0o644 if scenario == "non-executable-copilot" else 0o755)

if scenario == "installed-gh":
    gh = root / "gh"
    gh.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    gh.chmod(0o755)

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

if "PROBE_MARKER" in os.environ:
    module.STORAGE_PROBE_PATH.write_text(os.environ["PROBE_MARKER"], encoding="utf-8")
if scenario == "probe-marker-symlink":
    module.STORAGE_PROBE_PATH.symlink_to(module.TASK_PATH)
if scenario == "probe-marker-directory":
    module.STORAGE_PROBE_PATH.mkdir()
exit_code = module.main()
transcript = module.SESSION_LOG_PATH.read_text(encoding="utf-8")
print(json.dumps({
    "exitCode": exit_code,
    "transcript": transcript,
    "transcriptBytes": len(transcript.encode("utf-8")),
    "output": module.OUT_PATH.read_text(encoding="utf-8", errors="replace")
        if module.OUT_PATH.is_file() else "",
    "arguments": (root / "copilot-args").read_text(encoding="utf-8")
        if (root / "copilot-args").exists() else "",
}))
`;

interface HarnessResult {
  exitCode: number;
  transcript: string;
  transcriptBytes: number;
  output: string;
  arguments: string;
}

function runHarness(scenario: string, extraEnv: Record<string, string> = {}): HarnessResult {
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
        TEST_GITHUB_AGENT_ID: 'enclaveAgentId0123456789abcdef012345',
        TEST_PATH: `${root}:/usr/bin:/bin`,
        AWF_ENCLAVE_AGENT_ENGINE: 'copilot',
        AWF_ENCLAVE_AGENT_MAX_OUTPUT_BYTES: '1024',
        AWF_ENCLAVE_AGENT_DEADLINE_SECONDS: scenario === 'timeout' ? '1' : '30',
        AWF_ENCLAVE_AGENT_MODEL: 'test-model',
        ...(scenario === 'model-limits' ? {
          AWF_ENCLAVE_AGENT_MAX_MODEL_REQUESTS: '3',
          AWF_ENCLAVE_AGENT_MAX_MODEL_TOKENS: '10000',
        } : {}),
        ...(scenario === 'github-config' ? {
          AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
          AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
          AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
        } : {}),
        ...extraEnv,
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
  it('does not pass unsupported model-limit flags to Copilot CLI', () => {
    const result = runHarness('model-limits');

    expect(result.exitCode).toBe(0);
    expect(result.arguments).not.toContain('--max-model-requests');
    expect(result.arguments).not.toContain('--max-model-tokens');
  });

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

  it('accepts an installed gh tool without changing the protected execution path', () => {
    const result = runHarness('installed-gh');
    const transcript = events(result);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('true');
    expect(transcript).not.toContainEqual(expect.objectContaining({
      path: 'github-cli',
      type: 'forbidden-executable',
    }));
  });

  it('writes a private MCP-only configuration and redacts its agent identity', () => {
    const result = runHarness('github-config');
    const config = JSON.parse(result.output);

    expect(config).toEqual({
      mcpServers: {
        github: {
          type: 'http',
          url: 'http://172.31.0.40:8080/mcp/github',
          headers: {
            Authorization: 'enclaveAgentId0123456789abcdef012345',
          },
        },
      },
    });
    expect(result.transcript).toBe('[REDACTED]');
  });

  it('preserves boolean-like environment values while redacting ordinary secrets', () => {
    const result = runHarness('boolean-secrets');

    expect(result.transcript).toBe('true false 0 1 [REDACTED]');
    expect(result.transcript).not.toContain('ordinary-secret');
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
      log: expect.objectContaining({
        bytes: expect.any(Number),
        sha256: expect.any(String),
        sensitivity: 'redacted',
      }),
    }));
    expect(result.transcript).not.toContain('test-secret-token-value');
    expect(result.transcript).not.toContain('/private/repository/secret-path');
    expect(result.transcript).not.toContain('[REDACTED]');
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

    expect(result.exitCode).toBe(33);
    expect(result.output).toBe('');
    expect(transcript).toContainEqual({
      event: 'failure',
      category: 'result-empty',
    });
    expect(result.transcript).not.toContain('test-model');
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'engine-result',
      exitCode: 0,
      stdout: expect.objectContaining({
        bytes: 4,
        sha256: expect.any(String),
        sensitivity: 'redacted',
      }),
      stderr: expect.objectContaining({
        bytes: 0,
        sha256: expect.any(String),
        sensitivity: 'redacted',
      }),
    }));
    expect(transcript[transcript.length - 1]).toEqual({
      event: 'failure',
      category: 'result-empty',
    });
    expect(transcript).toContainEqual({
      event: 'output-normalization', inputState: 'empty', stdoutState: 'present',
    });
    expect(transcript).toContainEqual({ event: 'storage-probe', status: 'missing', milestones: [] });
  });

    it('reads both real output paths and verifies the compatibility link before and after the engine', () => {
      const result = runHarness('output-alias');
      expect(result.exitCode).toBe(0);
      expect(events(result).filter(event => event.event === 'output-verification')).toEqual([
        { event: 'output-verification', stage: 'before-engine', symlink: true, targetMatches: true,
          sameFile: true, contentsMatch: true, directReadable: true, aliasReadable: true,
          directState: 'empty', aliasState: 'empty' },
        { event: 'output-verification', stage: 'after-engine', symlink: true, targetMatches: true,
          sameFile: true, contentsMatch: true, directReadable: true, aliasReadable: true,
          directState: 'within-limit', aliasState: 'within-limit' },
      ]);
      expect(result.transcript).not.toContain('awf-enclave-entrypoint-');
    });

    it.each([
      ['output-alias-wrong', 0, { symlink: true, targetMatches: false, sameFile: false, contentsMatch: false }],
      ['output-alias-regular', 0, { symlink: false, sameFile: false, contentsMatch: true }],
      ['output-alias-broken', 32, { symlink: true, targetMatches: true,
        directReadable: false, aliasReadable: false, directState: 'unavailable', aliasState: 'unavailable' }],
      ['output-alias-empty', 33, { symlink: true, targetMatches: true, sameFile: true,
        contentsMatch: true, directState: 'empty', aliasState: 'empty' }],
    ] as Array<[string, number, Record<string, unknown>]>)(
      'distinguishes %s without substituting the direct path for the required result', (scenario, exitCode, expected) => {
        const result = runHarness(scenario);
        expect(result.exitCode).toBe(exitCode);
        expect(events(result)).toContainEqual(expect.objectContaining({
          event: 'output-verification', stage: 'after-engine', ...expected,
        }));
        expect(result.transcript).not.toContain('awf-enclave-entrypoint-');
      },
    );

    it.each([
      'link-lstat', 'link-readlink',
      ...['direct', 'alias'].flatMap(label => ['open', 'fstat', 'read', 'close'].map(op => `${label}-${op}`)),
    ])('preserves precise nonfatal verification errors for %s', suffix => {
      const operation = `verify-output-${suffix}`;
      const result = runHarness('verify-io', { FAULT_OPERATION: operation, FAULT_ERRNO: '5' });
      expect(result.exitCode).toBe(0);
      expect(events(result)).toContainEqual(expect.objectContaining({
        event: 'operation-error', operation, errno: 5, fatal: false,
      }));
      expect(result.transcript).not.toContain('test-secret-token-value');
      expect(result.transcript).not.toContain('/private/repository/secret-path');
    });

  it('distinguishes a reported probe write from the wrapper actual empty input without accepting stdout', () => {
    const milestones = [
      { stage: 'started', message: 'PRIVATE_PROBE_TEXT' },
      { stage: 'storage-complete', enospcObserved: true },
      { stage: 'cleanup-complete', probeFilesRemoved: true },
      { stage: 'output-write-complete' },
    ];
    const result = runHarness('probe-output-empty', {
      PROBE_MARKER: milestones.map(value => JSON.stringify(value)).join('\n'),
    });
    expect(result.exitCode).toBe(33);
    expect(events(result)).toContainEqual({
      event: 'storage-probe', status: 'captured',
      milestones: milestones.map(({ stage, ...flags }) => stage === 'started' ? { stage } : { stage, ...flags }),
    });
    expect(events(result)).toContainEqual({
      event: 'output-normalization', inputState: 'empty', stdoutState: 'present',
    });
    expect(result.transcript).not.toContain('PRIVATE_PROBE_TEXT');
  });

  it('keeps an early probe milestone separate from a successful result read', () => {
    const result = runHarness('success', { PROBE_MARKER: '{"stage":"started"}\n' });
    expect(result.exitCode).toBe(0);
    expect(events(result)).toContainEqual({
      event: 'storage-probe', status: 'captured', milestones: [{ stage: 'started' }],
    });
    expect(events(result)).toContainEqual({
      event: 'output-normalization', inputState: 'within-limit', stdoutState: 'present',
    });
  });

  it.each([
    ['probe-marker-symlink', {}, 'unsafe'],
    ['probe-marker-directory', {}, 'unsafe'],
    ['success', { PROBE_MARKER: 'x'.repeat(4097) }, 'oversized'],
    ['success', { PROBE_MARKER: '{"stage":"PRIVATE_STAGE"}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"started","enospcObserved":"PRIVATE_FLAG"}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":[]}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"output-check-failed","operation":{}}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"output-check-failed","operation":"PRIVATE_OPERATION"}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"output-check-failed","errno":true}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"output-verified","sameFile":"PRIVATE_FLAG"}' }, 'invalid'],
    ['success', { PROBE_MARKER: '{"stage":"started"}\n'.repeat(17) }, 'invalid'],
  ] as Array<[string, Record<string, string>, string]>)(
    'safely reports an unavailable %s marker without changing the result', (scenario, extraEnv, status) => {
      const result = runHarness(scenario, extraEnv);
      expect(result.exitCode).toBe(0);
      expect(events(result)).toContainEqual({ event: 'storage-probe', status, milestones: [] });
      expect(result.transcript).not.toContain('PRIVATE_');
      expect(result.transcript).not.toContain('private prompt sentinel');
    },
  );

  it.each<[string, number, string]>([
    ['stdout-only', 33, 'result-empty'],
    ['output-oversized', 34, 'result-too-large'],
    ['output-invalid-utf8', 35, 'result-invalid-utf8'],
    ['output-whitespace', 36, 'result-whitespace-only'],
    ['output-missing', 32, 'result-read-failed'],
    ['output-directory', 32, 'result-read-failed'],
  ])('distinguishes %s without attempting the final write', (scenario, exitCode, category) => {
    const result = runHarness(scenario);
    const transcript = events(result);
    expect(result.exitCode).toBe(exitCode);
    expect(transcript[transcript.length - 1]).toEqual({ event: 'failure', category });
    expect(transcript).not.toContainEqual(expect.objectContaining({
      stage: 'output-write-attempt',
    }));
    expect(result.transcript).not.toContain('private prompt sentinel');
    expect(result.transcript).not.toContain('test-secret-token-value');
    if (!['output-missing', 'output-directory'].includes(scenario)) {
      expect(transcript).toContainEqual({
        event: 'output-normalization',
        inputState: scenario === 'stdout-only' ? 'empty'
          : scenario === 'output-oversized' ? 'oversized' : 'within-limit',
        stdoutState: 'present',
      });
    }
  });

  it('accepts output exactly at the configured byte limit', () => {
    const result = runHarness('output-at-limit');
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('true');
  });

  it.each(
    ['output-reset', 'output-read', 'output-write'].flatMap(operation =>
      ['', '-open', '-close'].map(suffix => [operation + suffix, operation])),
  )('identifies the exact failed file operation %s', (operation, phase) => {
    const result = runHarness('injected-io', { FAULT_OPERATION: operation, FAULT_ERRNO: '28' });
    const transcript = events(result);
    expect(result.exitCode).toBe(phase === 'output-reset' ? 37 : phase === 'output-read' ? 32 : 30);
    expect(transcript).toContainEqual(expect.objectContaining({
      event: 'operation-error', operation, errno: 28, category: 'no-space', fatal: true,
    }));
    expect(transcript[transcript.length - 1]).toEqual({
      event: 'failure',
      category: phase === 'output-reset' ? 'result-reset-failed'
        : phase === 'output-read' ? 'result-read-failed' : 'result-write-failed',
    });
    expect(result.transcript).not.toContain('test-secret-token-value');
    expect(result.transcript).not.toContain('/private/repository/secret-path');
  });

  it.each([
    ['task-input-read-open', 11, {}],
    ['schema-input-read', 11, {}],
    ['github-agent-id-read', 10, {
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
    }],
    ['github-mcp-config-chmod', 10, {
      AWF_ENCLAVE_AGENT_GITHUB_ENABLED: 'true',
      AWF_ENCLAVE_AGENT_GITHUB_PROFILE: 'issues-read-v1',
      AWF_ENCLAVE_AGENT_GITHUB_MCP_URL: 'http://172.31.0.40:8080/mcp/github',
    }],
  ] as Array<[string, number, Record<string, string>]>)(
    'identifies input/configuration file operation %s', (operation, exitCode, extraEnv) => {
      const result = runHarness('injected-io', { FAULT_OPERATION: operation, ...extraEnv });
      expect(result.exitCode).toBe(exitCode);
      expect(events(result)).toContainEqual(expect.objectContaining({
        event: 'operation-error', operation, category: 'io-error',
      }));
      expect(result.transcript).not.toContain('test-secret-token-value');
      expect(result.transcript).not.toContain('/private/repository/secret-path');
    },
  );

  it('records post-engine output ownership, mode, access and size state without result contents', () => {
    const result = runHarness('output-mode');
    expect(events(result)).toContainEqual(expect.objectContaining({
      event: 'output-snapshot', stage: 'after-engine',
      uid: process.getuid!(), gid: process.getgid!(),
      paths: expect.arrayContaining([expect.objectContaining({
        path: 'output-file', type: 'file', uid: process.getuid!(), gid: process.getgid!(),
        mode: 0o640, readable: true, size: 'within-limit',
      })]),
    }));
    expect(result.transcript).not.toContain('"result":"true"');
  });

  it.each(['stat', 'open', 'write', 'close'])(
    'reports session-log %s failures through safe stderr without recursion',
    operation => {
      const result = runHarness(`session-log-${operation}`);
      expect(events(result)).toContainEqual(expect.objectContaining({
        event: 'operation-error', operation: `session-log-${operation}`, category: 'no-space', fatal: false,
      }));
      expect(result.transcript).not.toContain('test-secret-token-value');
      expect(result.transcript).not.toContain('/private/repository/secret-path');
    },
  );

  it('preserves the original operation failure when writing its diagnostic also fails', () => {
    const result = runHarness('session-log-write-operation');
    expect(events(result)).toEqual([
      expect.objectContaining({ operation: 'session-log-write', category: 'no-space', fatal: false }),
      { event: 'operation-error', operation: 'output-read-open',
        category: 'permission-denied', errno: 13, fatal: true },
    ]);
    expect(result.transcript).not.toContain('test-secret-token-value');
    expect(result.transcript).not.toContain('/private/repository/secret-path');
  });

  it('preserves the result failure category when writing its diagnostic also fails', () => {
    const result = runHarness('session-log-write-failure');
    expect(events(result)).toEqual([
      expect.objectContaining({ operation: 'session-log-write', category: 'no-space', fatal: false }),
      { event: 'failure', category: 'result-empty' },
    ]);
  });

  it('preserves the operation failure when closing the transcript inside an exception handler fails', () => {
    const result = runHarness('session-log-close-from-except');
    expect(events(result)).toEqual([
      expect.objectContaining({ operation: 'session-log-close', category: 'no-space', fatal: false }),
      { event: 'operation-error', operation: 'output-read-open',
        category: 'no-space', errno: 28, fatal: true },
    ]);
    expect(result.transcript).not.toContain('test-secret-token-value');
    expect(result.transcript).not.toContain('/private/repository/secret-path');
  });
  it('withholds raw engine stdout/stderr from the transcript by default', () => {
    const result = runHarness('success');
    const transcript = events(result);

    const engineResult = transcript.find((event) => event.event === 'engine-result');
    expect(engineResult).toBeDefined();
    expect(engineResult).toMatchObject({
      stdout: {
        bytes: expect.any(Number),
        sha256: expect.any(String),
        sensitivity: 'redacted',
      },
      stderr: {
        bytes: expect.any(Number),
        sha256: expect.any(String),
        sensitivity: 'redacted',
      },
    });
    expect((engineResult!.stdout as Record<string, unknown>).raw).toBeUndefined();
    expect((engineResult!.stderr as Record<string, unknown>).raw).toBeUndefined();
    expect(result.transcript).not.toContain('protected conversational output');
    expect(result.transcript).not.toContain('test-secret-token-value');
  });

  it('only restores raw redacted engine output under an explicit privileged debugging opt-in', () => {
    const result = runHarness('success', {
      AWF_ENCLAVE_AGENT_DEBUG_RAW_SESSION_LOGS: 'true',
    });
    const transcript = events(result);

    const engineResult = transcript.find((event) => event.event === 'engine-result');
    expect(engineResult).toBeDefined();
    expect(engineResult).toMatchObject({
      stdout: {
        sensitivity: 'raw-debug',
        raw: expect.stringContaining('protected conversational output'),
      },
      stderr: {
        sensitivity: 'raw-debug',
        raw: expect.stringContaining('[REDACTED]'),
      },
    });
    expect(result.transcript).not.toContain('test-secret-token-value');
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
