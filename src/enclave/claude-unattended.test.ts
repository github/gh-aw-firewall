import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
import signal
import subprocess
import threading

root = Path(os.environ["FIXTURE_ROOT"])
spec = importlib.util.spec_from_file_location("entrypoint", os.environ["ENTRYPOINT"])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.CLAUDE_BIN = os.environ["CLAUDE_BIN"]
module.AGENT_DIR = root / "agent"
module.OUT_PATH = root / "out"
module.SESSION_LOG_PATH = root / "session.jsonl"
module.SESSION_LOG_PATH.touch()
module.AGENT_DIR.mkdir()
(root / "output").mkdir()
(root / "output" / "out").touch()
module.OUT_PATH.symlink_to(root / "output" / "out")
(root / "seed").mkdir(mode=0o555)
(root / "home").mkdir()
(root / "config").mkdir()
(root / "tmp").mkdir()
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
            "input": {"command": "printf true > " + str(module.OUT_PATH)},
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
environment = {
    "PATH": "/usr/bin:/bin", "HOME": str(root / "home"), "TMPDIR": str(root / "tmp"),
    "CLAUDE_CONFIG_DIR": str(root / "config"),
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:" + str(server.server_port),
    "ANTHROPIC_API_KEY": "******", "ANTHROPIC_AUTH_TOKEN": "synthetic-fixture",
    "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1",
}
if os.environ.get("ALLOW_TOOLS") == "true":
    os.environ["AWF_ENCLAVE_AGENT_CLAUDE_PERMISSION_PROMPTS"] = "none"
    os.environ["AWF_ENCLAVE_AGENT_CLAUDE_ALLOWED_TOOLS"] = "Bash,Read,Write,Edit,Glob,Grep"
command = module.build_engine_command("claude", "claude-haiku-4-5",
    "Run the shell diagnostic and write true to " + str(module.OUT_PATH), root)
try:
    process = subprocess.Popen(command, cwd=root / "seed", env=environment,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        stdout, stderr = module.communicate_claude(process, 12)
        result = {"exitCode": process.returncode, "stdoutBytes": len(stdout),
                  "stderrBytes": len(stderr), "timeout": False}
        result["errorClasses"] = [code for code in ["EROFS", "EACCES", "ENOENT", "ECONNREFUSED"]
                                  if code.encode() in stderr]
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        result = {"exitCode": None, "stdoutBytes": len(stdout),
                  "stderrBytes": len(stderr), "timeout": True}
finally:
    server.shutdown()
result["requests"] = requests
result["output"] = module.OUT_PATH.read_text() if module.OUT_PATH.exists() else ""
result["stages"] = [event["stage"] for event in map(json.loads, module.SESSION_LOG_PATH.read_text().splitlines())
                    if event.get("event") == "progress"]
print(json.dumps(result))
`;

pinnedTest.each([false, true])('checks pinned Claude shell execution with explicit approvals=%s', approved => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-claude-unattended-'));
  try {
    const stagedEntrypoint = path.join(root, 'entrypoint.py');
    fs.copyFileSync(entrypoint, stagedEntrypoint);
    fs.chmodSync(stagedEntrypoint, 0o444);
    const ownership = spawnSync('sudo', ['chown', '65534:65534', root]);
    expect(ownership.status).toBe(0);
    const result = spawnSync('sudo', ['--preserve-env=ENTRYPOINT,FIXTURE_ROOT,CLAUDE_BIN,ALLOW_TOOLS',
      'unshare', '--net', '--mount', '--pid', '--fork',
      '--kill-child', '--mount-proc', '/bin/sh', '-c',
      'mount --make-rprivate / && mount --bind / / && mount -o remount,bind,ro /'
      + ' && mount -o remount,bind,ro /dev/shm'
      + ' && mount --bind "$2" "$2" && mount -o remount,bind,rw "$2"'
      + ' && ip link set lo up'
      + ' && exec setpriv --reuid=65534 --regid=65534 --clear-groups --no-new-privs --bounding-set=-all python3 -c "$1"',
      'fixture', fixture, root], {
      env: { PATH: '/usr/bin:/bin:/usr/local/bin', ENTRYPOINT: stagedEntrypoint,
        FIXTURE_ROOT: root, CLAUDE_BIN: binary!, ALLOW_TOOLS: String(approved) },
      encoding: 'utf8', timeout: 20_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stderr).toBe('');
    const observed = JSON.parse(result.stdout);
    expect(observed).toEqual(expect.objectContaining({
      timeout: false, exitCode: 0, output: approved ? 'true' : '',
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
