import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec');

function containerEnvironment(root: string): Record<string, string> {
  const { launchArgs } = deriveEnclaveContainerSpec({
    config: {
      engine: 'claude', profile: 'anthropic', model: 'claude-haiku-4-5',
      apiEndpoint: 'http://172.31.0.30:10001',
      hostWorkDir: '/private/work', hostSeedsDir: '/private/seeds',
      enclaveMountDir: `${root}/runtime/agent`, enclaveSeedPath: '/awf/seed',
      enclaveTaskPath: '/awf/task.txt', enclaveSchemaPath: '/awf/schema.json',
      enclaveSeccompPath: '/private/seccomp.json', enclaveImage: 'enclave:test',
      enclaveUid: 65534, enclaveGid: 65534, network: 'awf-enclave-agent',
      memoryLimit: '768m', tmpfsLimit: '96m', cpuLimit: 0.5, pidsLimit: 47,
      timeoutSeconds: 12, maxOutputBytes: 1024,
    },
    runId: 'a'.repeat(32), invocationId: 'b'.repeat(32), seedId: 'c'.repeat(32),
  });
  return Object.fromEntries(launchArgs.flatMap((arg: string, index: number) => {
    if (arg !== '--env') return [];
    const value = launchArgs[index + 1] as string;
    const separator = value.indexOf('=');
    return [[value.slice(0, separator), value.slice(separator + 1)]];
  }));
}

// Opt in with the same immutable Claude binary installed in the enclave image.
const binary = process.env.AWF_TEST_CLAUDE_BIN;
const pinnedTest = binary ? it : it.skip;
const entrypoint = path.resolve(__dirname, '../../containers/enclave/agent-entrypoint.py');
const fixture = String.raw`
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shlex
import threading

staged = Path(os.environ["FIXTURE_ROOT"])
root = staged / "runtime"
spec = importlib.util.spec_from_file_location("entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.CLAUDE_BIN = os.environ["CLAUDE_BIN"]
module.AGENT_DIR = root / "agent"
module.OUT_PATH = root / "out"
module.OUTPUT_DIR = root / "output"
module.SEED_DIR = staged / "seed"
module.TASK_PATH = staged / "task.txt"
module.SCHEMA_PATH = staged / "schema.json"
module.TEMP_DIR = root / "tmp"
module.SHARED_MEMORY_DIR = Path("/dev/shm")
module.STORAGE_PROBE_PATH = module.TEMP_DIR / ".awf-enclave-storage-probe.jsonl"
module.SESSION_LOG_PATH = root / "session.jsonl"
module.SESSION_LOG_PATH.touch()
module.AGENT_DIR.mkdir()
(root / "output").mkdir()
(root / "output" / "out").touch()
module.OUT_PATH.symlink_to(root / "output" / "out")
(root / "tmp").mkdir()
diagnostic = (
    "import json, os; from pathlib import Path; "
    "status = Path('/proc/self/status').read_text(); "
    "valid = os.geteuid() == 65534 and os.getegid() == 65534 "
    "and int(next(line.split()[1] for line in status.splitlines() if line.startswith('CapEff:')), 16) == 0 "
    "and 'NoNewPrivs:\\t1' in status "
    "and bool(os.statvfs(" + repr(str(module.SEED_DIR)) + ").f_flag & os.ST_RDONLY); "
    "Path(" + repr(str(module.OUT_PATH)) + ").write_text(json.dumps(valid))"
)
shell_command = "python3 -c " + shlex.quote(diagnostic)
requests = []
class Provider(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass
    def do_POST(self):
        size = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(size))
        requests.append(self.path)
        if self.path.endswith("/count_tokens"):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"input_tokens":1}')
            return
        has_result = any(
            isinstance(message.get("content"), list) and any(
                block.get("type") == "tool_result" for block in message["content"]
            ) for message in body.get("messages", [])
        )
        content = [{"type": "text", "text": "done"}] if has_result else [{
            "type": "tool_use", "id": "tool_fixture", "name": "Bash",
            "input": {"command": shell_command},
        }]
        stop = "end_turn" if has_result else "tool_use"
        message = {
            "id": "msg_fixture", "type": "message", "role": "assistant",
            "model": "claude-haiku-4-5", "content": content, "stop_reason": stop,
            "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1},
        }
        self.send_response(200)
        if not body.get("stream"):
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(message).encode())
            return
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        def event(kind, payload):
            self.wfile.write(("event: " + kind + "\ndata: " + json.dumps(payload) + "\n\n").encode())
        event("message_start", {"type": "message_start", "message": dict(message, content=[], stop_reason=None)})
        block = content[0]
        start = dict(block, text="") if block["type"] == "text" else dict(block, input={})
        event("content_block_start", {"type": "content_block_start", "index": 0, "content_block": start})
        delta = {"type": "text_delta", "text": block["text"]} if block["type"] == "text" else {
            "type": "input_json_delta", "partial_json": json.dumps(block["input"]),
        }
        event("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": delta})
        event("content_block_stop", {"type": "content_block_stop", "index": 0})
        event("message_delta", {"type": "message_delta", "delta": {"stop_reason": stop, "stop_sequence": None},
                                "usage": {"output_tokens": 1}})
        event("message_stop", {"type": "message_stop"})

server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
environment = json.loads(os.environ["CONTAINER_ENVIRONMENT"])
environment.update(PATH="/usr/bin:/bin", TMPDIR=str(module.TEMP_DIR))
legacy = os.environ.get("LEGACY_ARGV") == "true"
if os.environ.get("ALLOW_TOOLS") != "true":
    environment["AWF_ENCLAVE_AGENT_CLAUDE_ALLOWED_TOOLS"] = "Read,Glob,Grep"
if legacy:
    environment.pop("AWF_ENCLAVE_AGENT_CLAUDE_PERMISSION_PROMPTS", None)
    environment.pop("AWF_ENCLAVE_AGENT_CLAUDE_ALLOWED_TOOLS", None)
    build_command = module.build_engine_command
    def build_legacy_command(*args):
        command = build_command(*args)
        command[command.index("--permission-prompts") + 1] = "auto"
        return command
    module.build_engine_command = build_legacy_command
os.environ.clear()
os.environ.update(environment)
configure_environment = module.configure_engine_environment
def configure_fixture_environment(engine):
    configure_environment(engine)
    # Substitute only the provider edge after validating the production environment.
    os.environ["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:" + str(server.server_port)
module.configure_engine_environment = configure_fixture_environment
try:
    result = {"exitCode": module.main()}
finally:
    server.shutdown()
result["requests"] = requests
result["output"] = module.OUT_PATH.read_text() if module.OUT_PATH.exists() else ""
events = list(map(json.loads, module.SESSION_LOG_PATH.read_text().splitlines()))
result["stages"] = [event["stage"] for event in events if event.get("event") == "progress"]
result["nativeExit"] = next(event["exitCode"] for event in events if event["event"] == "engine-result")
result["startupFailures"] = [event["classification"] for event in events
                             if event.get("stage") == "claude-startup-failure"]
result["streamSummary"] = next(event for event in events if event.get("stage") == "claude-stream-summary")
print(json.dumps(result))
`;

it('builds unattended Claude arguments from the production container environment', () => {
  const result = spawnSync('python3', ['-c', String.raw`
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps(module.build_engine_command("claude", "trusted-model", "task", Path("/agent"))))
`], {
    env: { ...containerEnvironment('/fixture'), PATH: process.env.PATH, ENTRYPOINT: entrypoint },
    encoding: 'utf8',
  });
  expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  expect(JSON.parse(result.stdout)).toEqual(expect.arrayContaining([
    '--permission-mode', 'default', '--permission-prompts', 'none',
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
  ]));
});

pinnedTest.each([
  { approved: false, legacy: false },
  { approved: true, legacy: false },
  { approved: false, legacy: true },
])('checks pinned Claude production launch %j', ({ approved, legacy }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-claude-unattended-'));
  try {
    const stagedEntrypoint = path.join(root, 'entrypoint.py');
    fs.copyFileSync(entrypoint, stagedEntrypoint);
    fs.chmodSync(stagedEntrypoint, 0o444);
    fs.mkdirSync(path.join(root, 'runtime'));
    fs.mkdirSync(path.join(root, 'seed'), { mode: 0o555 });
    fs.writeFileSync(path.join(root, 'task.txt'), 'Run the shell diagnostic and write its boolean result to /awf/out.', { mode: 0o444 });
    fs.writeFileSync(path.join(root, 'schema.json'), '{"type":"boolean"}', { mode: 0o444 });
    fs.chmodSync(root, 0o755);
    const result = spawnSync('sudo', ['--preserve-env=ENTRYPOINT,FIXTURE_ROOT,CLAUDE_BIN,ALLOW_TOOLS,LEGACY_ARGV,CONTAINER_ENVIRONMENT',
      'unshare', '--net', '--mount', '--pid', '--fork',
      '--kill-child', '--mount-proc', '/bin/sh', '-c',
      'mount --make-rprivate / && mount --bind / / && mount -o remount,bind,ro /'
      + ' && mount -o remount,bind,ro /dev/shm'
      + ' && mount -t tmpfs -o rw,noexec,nosuid,nodev,size=96m,uid=65534,gid=65534 tmpfs "$2/runtime"'
      + ' && ip link set lo up'
      + ' && exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs --bounding-set=-all python3 -c "$1"',
      'fixture', fixture, root], {
      env: { PATH: '/usr/bin:/bin:/usr/local/bin', ENTRYPOINT: stagedEntrypoint,
        FIXTURE_ROOT: root, CLAUDE_BIN: binary!, ALLOW_TOOLS: String(approved),
        LEGACY_ARGV: String(legacy),
        CONTAINER_ENVIRONMENT: JSON.stringify(containerEnvironment(root)) },
      encoding: 'utf8', timeout: 20_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stderr).toBe('');
    const observed = JSON.parse(result.stdout);
    if (legacy) {
      expect(observed).toEqual(expect.objectContaining({
        exitCode: 24, nativeExit: 1, output: '', requests: [],
        startupFailures: ['invalid-option-value'],
      }));
      expect(observed.stages).not.toContain('claude-initialized');
      return;
    }
    expect(observed).toEqual(expect.objectContaining({
      exitCode: approved ? 0 : 33, nativeExit: 0, output: approved ? 'true' : '',
    }));
    expect(observed.requests.some((route: string) => route.split('?')[0] === '/v1/messages')).toBe(true);
    expect(observed.stages).toEqual(expect.arrayContaining([
      'claude-initialized', 'claude-response', 'claude-tool-requested', 'claude-result',
    ]));
    expect(observed.stages.includes('claude-permission-denied')).toBe(!approved);
    if (approved) expect(JSON.parse(observed.output)).toBe(true);
  } finally {
    spawnSync('sudo', ['rm', '-rf', '--', root]);
  }
}, 25_000);
