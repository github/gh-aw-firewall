/**
 * Real pinned Codex shell tools, with synthetic Responses inference only.
 * Supply AWF_DOCKER_ENCLAVE_CODEX_SHELL_IMAGE and run as root with CAP_SYS_ADMIN.
 * Uses the production entrypoint, container specification and bounded storage.
 */
import { execFileSync } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Ajv from 'ajv';
import {
  mountDockerHostStorage, unmountDockerHostStorage,
  type DockerHostMountIdentity,
} from '../../src/enclave/docker-host-storage';

/* eslint-disable @typescript-eslint/no-require-imports */
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');
const { preserveInvocationSession } = require('../../containers/enclave/agent-executor/workspace.js');
const { probe } = require('../../scripts/ci/run-enclave-agent-regression.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const image = process.env.AWF_DOCKER_ENCLAVE_CODEX_SHELL_IMAGE;
const acceptance = image ? describe : describe.skip;
const root = path.resolve(__dirname, '../..');
const pinnedVersion = '0.159.3';
const MiB = 1024 ** 2;

// No real provider, credentials, or session payloads. Only fixed status metadata is logged.
const provider = String.raw`
import json, os, time
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
    def do_POST(self):
        assert self.path == "/v1/responses"
        Path("/tmp/ready").touch()
        for _ in range(600):
            if Path("/tmp/release").exists(): break
            time.sleep(0.05)
        else: raise RuntimeError("topology check did not release inference")
        size = int(self.headers["Content-Length"])
        assert size <= 1024 * 1024
        request = json.loads(self.rfile.read(size))
        outputs = [item for item in request.get("input", [])
                   if isinstance(item, dict) and item.get("type") == "function_call_output"]
        if outputs:
            output = str(outputs[-1]["output"])
            print(json.dumps({"toolResultReceived": True,
                              "toolFailed": "Process exited with code 127" in output
                                            or "Exit code: 127" in output}), flush=True)
        if not outputs and os.environ["SCENARIO"] != "no-tool":
            names = {tool.get("name") for tool in request["tools"]}
            assert "exec_command" in names or "shell_command" in names
            name = "exec_command" if "exec_command" in names else "shell_command"
            arguments = {"cmd" if name == "exec_command" else "command": os.environ["COMMAND"]}
            if name == "exec_command": arguments["yield_time_ms"] = 10000
            item = {"type": "function_call", "id": "fc_fixture", "call_id": "call_fixture",
                    "name": name, "arguments": json.dumps(arguments), "status": "completed"}
        else:
            item = {"type": "message", "id": "msg_fixture", "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": "true", "annotations": []}]}
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        def emit(kind, **fields):
            data = json.dumps({"type": kind, **fields})
            self.wfile.write(("event: " + kind + "\ndata: " + data + "\n\n").encode())
        response = {"id": "resp_fixture", "object": "response", "status": "in_progress",
                    "output": []}
        emit("response.created", response=response)
        emit("response.output_item.added", output_index=0, item=item)
        emit("response.output_item.done", output_index=0, item=item)
        emit("response.completed", response={**response, "status": "completed", "output": [item],
             "usage": {"input_tokens": 1, "output_tokens": 1, "total_tokens": 2}})
        self.wfile.flush()

HTTPServer(("0.0.0.0", 10000), Handler).serve_forever()
`;

acceptance('Docker enclave pinned Codex shell execution', () => {
  test.each(['diagnostic', 'forged-session', 'failed-command', 'no-tool'])(
    '%s preserves outer confinement and the canonical result contract',
    async scenario => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-codex-shell-'));
      const runId = randomBytes(16).toString('hex');
      const invocationId = 'shell-test';
      const seedId = 'a'.repeat(32);
      const network = `awf-codex-shell-${runId}`;
      const peerNetwork = `awf-codex-peer-${runId}`;
      const proxyName = `awf-codex-proxy-${runId}`;
      const peerName = `awf-codex-peer-${runId}`;
      const docker = (args: string[]) => execFileSync('docker', args, {
        encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024,
        env: { PATH: '/usr/bin:/bin', DOCKER_HOST: process.env.DOCKER_HOST, HOME: directory },
      }).trim();
      let mount: DockerHostMountIdentity | undefined;
      let containerName: string | undefined;
      const containers: string[] = [];
      const networks: string[] = [];
      const diagnosticScenario = scenario === 'diagnostic' || scenario === 'forged-session';
      const privateSentinel = 'private seed transcript sentinel';
      try {
        expect(fs.readFileSync(path.join(root, 'containers/enclave/Dockerfile'), 'utf8'))
          .toContain(`ARG CODEX_VERSION=${pinnedVersion}`);
        mount = await mountDockerHostStorage(
          path.join(directory, 'storage'), `awf-codex-${runId}`, 256 * MiB,
        );
        const invocation = path.join(mount.target, invocationId);
        fs.mkdirSync(invocation);
        fs.mkdirSync(path.join(invocation, 'agent'), { mode: 0o700 });
        fs.chownSync(path.join(invocation, 'agent'), 65534, 65534);
        const seed = path.join(directory, 'seeds', seedId);
        fs.mkdirSync(seed, { recursive: true, mode: 0o755 });
        fs.writeFileSync(path.join(seed, 'README.md'), 'public fixture seed\n', { mode: 0o444 });
        fs.writeFileSync(path.join(seed, 'private.txt'), privateSentinel, { mode: 0o444 });
        docker(['network', 'create', '--internal', '--subnet', '172.31.0.0/24', network]);
        networks.push(network);
        docker(['network', 'create', '--internal', peerNetwork]);
        networks.push(peerNetwork);
        const confinement = [
          '--read-only', '--user', '65534:65534', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges:true',
          '--security-opt', `seccomp=${path.join(root, 'containers/enclave/seccomp.json')}`,
          '--memory', '256m', '--memory-swap', '256m', '--cpus', '0.5', '--pids-limit', '32',
        ];
        docker([
          'run', '-d', '--pull', 'never', '--name', peerName, '--network', peerNetwork,
          ...confinement, '--entrypoint', '/usr/bin/python3', image!,
          '-u', '-m', 'http.server', '18080',
        ]);
        containers.push(peerName);
        docker([
          'exec', peerName, '/usr/bin/python3', '-c',
          'import socket, time\nfor _ in range(100):\n try:\n  socket.create_connection(("127.0.0.1", 18080), timeout=0.1).close(); break\n except OSError: time.sleep(0.05)\nelse: raise RuntimeError("fixture not ready")',
        ]);
        const peer = JSON.parse(docker(['inspect', peerName]))[0]
          .NetworkSettings.Networks[peerNetwork].IPAddress;
        const task = probe('codex', 'docker', randomBytes(24).toString('hex'), peer);
        const schema = {
          type: 'object', additionalProperties: false,
          required: Object.keys(task.expected),
          properties: Object.fromEntries(Object.entries(task.expected).map(([key, value]) =>
            [key, { const: value }])),
        };
        const diagnostic = task.prompt.match(/python3 - <<'PY'\n([\s\S]*)\nPY\n/)[1];
        const command = scenario === 'failed-command' ? '/awf/nonexistent-shell' : [
          "python3 - <<'PY'",
          'import os',
          'from pathlib import Path',
          'mounts = {f[1]: f[3].split(",") for f in (line.split() for line in Path("/proc/mounts").read_text().splitlines())}',
          'assert "ro" in mounts["/"] and "ro" in mounts["/awf/seed"]',
          'for target in ["/agent", "/tmp"]:',
          '    assert all(flag in mounts[target] for flag in ["rw", "noexec", "nosuid", "nodev"])',
          '    assert os.statvfs(target).f_blocks * os.statvfs(target).f_frsize == 256 * 1024 ** 2',
          diagnostic,
          ...(scenario === 'forged-session' ? [
            'import json',
            'Path("/awf/session.jsonl").write_text(json.dumps({"event": "session", "sensitivity": "redacted", "private": Path("/awf/seed/private.txt").read_text()}) + "\\n")',
          ] : []),
          'PY',
        ].join('\n');
        docker([
          'run', '-d', '--pull', 'never', '--name', proxyName, '--network', network,
          '--ip', '172.31.0.30', ...confinement,
          '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=1m',
          '--env', `COMMAND=${command}`, '--env', `SCENARIO=${scenario}`,
          '--entrypoint', '/usr/bin/python3', image!, '-u', '-c', provider,
        ]);
        containers.push(proxyName);
        expect(docker(['exec', proxyName, '/usr/local/bin/codex', '--version']))
          .toBe(`codex-cli ${pinnedVersion}`);
        docker([
          'exec', proxyName, '/usr/bin/python3', '-c',
          'import socket, time\nfor _ in range(100):\n try:\n  socket.create_connection(("127.0.0.1", 10000), timeout=0.1).close(); break\n except OSError: time.sleep(0.05)\nelse: raise RuntimeError("fixture not ready")',
        ]);
        for (const [name, contents] of [
          ['task.txt', task.prompt], ['schema.json', JSON.stringify(schema)],
          ['out', ''], ['session.jsonl', ''],
        ]) {
          const filename = path.join(invocation, name);
          fs.writeFileSync(filename, contents, { mode: 0o600 });
          fs.chownSync(filename, 65534, 65534);
        }
        const spec = deriveEnclaveContainerSpec({
          runId, invocationId, seedId,
          config: {
            hostWorkDir: mount.target, hostSeedsDir: path.join(directory, 'seeds'),
            enclaveImage: image, enclaveUid: 65534, enclaveGid: 65534,
            enclaveSeccompPath: path.join(root, 'containers/enclave/seccomp.json'),
            network, memoryLimit: '768m', cpuLimit: 1, pidsLimit: 128, tmpfsLimit: '256m',
            enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed',
            enclaveTaskPath: '/awf/task.txt', enclaveSchemaPath: '/awf/schema.json',
            engine: 'codex', apiEndpoint: 'http://172.31.0.30:10000', profile: 'openai',
            model: 'gpt-5.4', timeoutSeconds: 60, maxOutputBytes: 2048,
          },
        });
        containerName = spec.containerName as string;
        // Overlay only current reviewed source; all production security settings remain.
        const args = [...spec.launchArgs];
        args[args.indexOf('--entrypoint') + 1] = '/usr/bin/python3';
        args.push('/usr/local/bin/run-enclave-agent');
        args.splice(1, 0, '-d',
          '-v', `${path.join(root, 'containers/enclave/agent-entrypoint.py')}:/usr/local/bin/run-enclave-agent:ro`,
          '-v', `${path.join(root, 'containers/enclave/public_debug_capture.py')}:/usr/local/bin/public_debug_capture.py:ro`);
        docker(args);
        containers.push(containerName);
        docker([
          'exec', proxyName, '/usr/bin/python3', '-c',
          'import time\nfrom pathlib import Path\nfor _ in range(600):\n if Path("/tmp/ready").exists(): break\n time.sleep(0.05)\nelse: raise RuntimeError("inference not ready")',
        ]);
        const members = Object.values(JSON.parse(docker(['network', 'inspect', network]))[0].Containers)
          .map((member: unknown) => (member as { Name: string }).Name).sort();
        expect(members).toEqual([proxyName, containerName].sort());
        docker(['exec', proxyName, '/usr/bin/python3', '-c',
          'from pathlib import Path; Path("/tmp/release").touch()']);
        expect(docker(['wait', containerName])).toBe(diagnosticScenario ? '0' : '33');
        const state = JSON.parse(docker(['inspect', containerName]))[0];
        expect(state.State.OOMKilled).toBe(false);
        expect(state.HostConfig.Privileged).toBe(false);
        expect(state.HostConfig.CapAdd).toBeNull();
        const events = fs.readFileSync(path.join(invocation, 'session.jsonl'), 'utf8')
          .trim().split('\n').map(line => JSON.parse(line));
        expect(events).toContainEqual(expect.objectContaining({ event: 'engine-result', exitCode: 0 }));
        const output = fs.readFileSync(path.join(invocation, 'out'), 'utf8');
        if (diagnosticScenario) {
          const result = JSON.parse(output);
          expect(new Ajv().validate(schema, result)).toBe(true);
          expect(result).toEqual(task.expected);
          expect(events[events.length - 1]).toEqual({ event: 'success' });
        } else {
          expect(output).toBe('');
          expect(events[events.length - 1]).toEqual({ event: 'failure', category: 'result-empty' });
        }
        const metadata = docker(['logs', proxyName]);
        if (scenario !== 'no-tool') {
          expect(JSON.parse(metadata)).toEqual({
            toolResultReceived: true, toolFailed: scenario === 'failed-command',
          });
        } else expect(metadata).toBe('');
        if (scenario === 'forged-session') {
          expect(JSON.stringify(events)).toContain(privateSentinel);
        } else expect(JSON.stringify(events)).not.toContain(privateSentinel);
        const auditDir = path.join(directory, 'audit');
        expect(preserveInvocationSession(path.join(invocation, 'session.jsonl'), auditDir, invocationId))
          .toBe(true);
        expect(fs.existsSync(path.join(auditDir, 'raw-debug-sessions'))).toBe(false);
        const exportedSession = fs.readFileSync(
          path.join(auditDir, 'sessions', `${invocationId}.jsonl`), 'utf8',
        );
        expect(exportedSession).not.toContain(privateSentinel);
        expect(exportedSession).not.toContain(JSON.stringify(command).slice(1, -1));
        expect(exportedSession).not.toContain(task.expected.proof);
        expect(JSON.stringify(events)).not.toContain('bwrap:');
        expect(JSON.stringify(events)).not.toContain(JSON.stringify(command).slice(1, -1));
        expect(JSON.stringify(events)).not.toContain(task.expected.proof);
      } finally {
        // Confirm every workload stopped before releasing its writable storage.
        if (containerName && !containers.includes(containerName)) {
          const existing = docker(['ps', '-aq', '--filter', `name=^/${containerName}$`]);
          if (existing) containers.push(containerName);
        }
        for (const name of containers.reverse()) {
          docker(['rm', '-f', name]);
          expect(docker(['ps', '-aq', '--filter', `name=^/${name}$`])).toBe('');
        }
        for (const name of networks.reverse()) docker(['network', 'rm', name]);
        if (mount) await unmountDockerHostStorage(mount);
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }, 180_000,
  );
});
