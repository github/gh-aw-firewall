/**
 * Real host-adapter acceptance, deliberately separate from mocked runner tests.
 * Run as root (util-linux mount requires real UID zero):
 * mkdir -p .git/enclave-docker-host-cache
 * sudo env -u TMPDIR PATH="$PATH" \
 *   NODE_DISABLE_COMPILE_CACHE=1 AWF_DOCKER_HOST_ACCEPTANCE=1 \
 *   node node_modules/jest/bin/jest.js \
 *   --config tests/setup/jest.integration.config.js --cacheDirectory .git/enclave-docker-host-cache \
 *   --runInBand enclave-docker-host.test.ts
 * The agent image substitutes only Copilot, not the audited Python entrypoint.
 * This exercises confinement, NOT a live Copilot model or provider.
 */
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createDockerHostEnclaveExecutor, type DockerHostExecutorEntry, type DockerHostEnclaveExecutorBackend,
} from '../../src/enclave/docker-host-executor';
import { assertDockerHostPath } from '../../src/enclave/docker-host-storage';
import type {
  HostEnclaveExecutorBackend, HostExecutorInvocationPlan,
} from '../../src/enclave/host-executor-server';
import { startHostExecutorServer } from '../../src/enclave/host-executor-server';

const enabled = process.env.AWF_DOCKER_HOST_ACCEPTANCE === '1';
const acceptance = enabled ? describe : describe.skip;
const root = path.resolve(__dirname, '../..');
const subprocessEnv = { ...process.env, NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1' };
const image = 'awf-enclave-script:host-acceptance';
const agentImage = 'awf-enclave-agent:host-acceptance-fixture';
const MiB = 1024 * 1024;
const sentinel = 'PRIVATE-ACCEPTANCE-CONTENT-MUST-NOT-ESCAPE';
const schema = {
  type: 'object', fields: [{ name: 'passed', schema: { type: 'boolean' } }],
} as const;

function docker(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, {
      cwd: root, timeout: 180_000, maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]} failed: ${stderr}`));
      else resolve(stdout.trim());
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

async function until<T>(operation: () => Promise<T | undefined>, description: string): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = await operation();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

// Assertions execute as the actual sandbox user, not docker exec's default root.
const confinement = `
import errno, json, os, socket, time
from pathlib import Path
assert (os.geteuid(), os.getegid()) == (65534, 65534)
assert Path("/awf/seed/private.txt").read_text() == ${JSON.stringify(sentinel)}
for target in ["/awf/seed/private.txt", "/etc/passwd"]:
    try:
        with open(target, "ab") as f: f.write(b"x")
        raise AssertionError("readonly mutation succeeded")
    except OSError as e:
        assert e.errno == errno.EROFS
assert "NoNewPrivs:\\t1" in Path("/proc/self/status").read_text()
assert "CapEff:\\t0000000000000000" in Path("/proc/self/status").read_text()
assert Path("/sys/fs/cgroup/memory.max").read_text().strip() == str(128 * 1024 * 1024)
assert Path("/sys/fs/cgroup/pids.max").read_text().strip() == "48"
quota, period = map(int, Path("/sys/fs/cgroup/cpu.max").read_text().split())
assert quota / period == 0.5
assert os.statvfs("/tmp").f_blocks * os.statvfs("/tmp").f_frsize == 8 * 1024 * 1024
`;

acceptance('Docker host enclave adapter: REAL daemon acceptance', () => {
  const runId = randomBytes(16).toString('hex');
  const directory = path.join(os.tmpdir(), `awf-e-${runId}`);
  const seedId = 'a'.repeat(32);
  const seed = path.join(directory, 'seeds', seedId);
  const journalDir = path.join(directory, 'journal');
  const network = `awf-enclave-acceptance-${randomBytes(5).toString('hex')}`;
  const backends: HostEnclaveExecutorBackend[] = [];
  const children: ChildProcess[] = [];
  const commandTrace: string[] = [];
  const transcripts = new Map<string, string>();
  const exitedStates = new Map<string, { OOMKilled: boolean; ExitCode: number }>();
  let proxyId: string | undefined;
  let networkCreated = false;

  function entry(kind: 'script' | 'agent'): DockerHostExecutorEntry {
    return {
      entryId: kind, executorKind: kind,
      hostWritableBytes: 8 * MiB,
      aggregateWritableBytes: kind === 'script' ? 88 * MiB : 24 * MiB,
      config: {
        memoryLimit: '128m', cpuLimit: '0.5', pidsLimit: 48, tmpfsLimit: '8m',
        maxOutputBytes: 2048,
        ...(kind === 'script' ? {
          queryUid: 65534, queryGid: 65534,
          queryImage: image, querySeccompPath: path.join(root, 'containers/enclave/seccomp.json'),
          queryMountDir: '/query', queryScriptPath: '/awf/query-script.py',
        } : {
          enclaveUid: 65534, enclaveGid: 65534,
          engine: 'copilot', enclaveImage: agentImage, network,
          enclaveSeccompPath: path.join(root, 'containers/enclave/seccomp.json'),
          enclaveMountDir: '/agent', enclaveSeedPath: '/awf/seed',
          enclaveTaskPath: '/awf/task.txt', enclaveSchemaPath: '/awf/schema.json',
          apiEndpoint: 'http://172.31.0.30:10002', profile: 'openai',
          model: 'confinement-fixture', timeoutSeconds: 30,
        }),
      },
    };
  }

  function options() {
    return { runId, journalDir, entries: [entry('script'), entry('agent')] };
  }

  function backend(): DockerHostEnclaveExecutorBackend {
    const value = createDockerHostEnclaveExecutor({
      ...options(),
      // Observe actual daemon commands; no Docker response is mocked or rewritten.
      dockerCommand: (args, signal) => new Promise((resolve) => {
        if (args[0] === 'rm') {
          for (const id of fs.readdirSync(path.join(directory, 'invocations'))) {
            const session = path.join(directory, 'invocations', id, 'session.jsonl');
            if (fs.existsSync(session)) transcripts.set(id, fs.readFileSync(session, 'utf8'));
          }
        }
        execFile('docker', [...args], { signal, timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
          const exitCode = error ? typeof error.code === 'number' ? error.code : 1 : 0;
          commandTrace.push(`${JSON.stringify(args)} => ${exitCode} ${stderr}`);
          if (args[0] === 'inspect' && exitCode === 0) {
            const inspected = JSON.parse(stdout)[0];
            if (inspected.State.Status === 'exited' && !inspected.Name.endsWith('-probe')) {
              exitedStates.set(inspected.Config.Labels['awf.enclave.invocation'], inspected.State);
            }
          }
          resolve({ exitCode, stdout });
        });
      }),
    });
    backends.push(value);
    return value;
  }

  function plan(kind: 'script' | 'agent', payload: string): HostExecutorInvocationPlan {
    const invocationId = randomBytes(16).toString('hex');
    return {
      runId, entryId: kind, invocationId, executorKind: kind,
      timeoutMs: 30_000, requestHash: 'b'.repeat(64), admissionId: 'c'.repeat(32),
      schemaHash: 'd'.repeat(64), schema, payload,
      invocationHostDir: path.join(directory, 'invocations', invocationId),
      seedId, seedHostPath: seed,
    };
  }

  async function running(invocation: HostExecutorInvocationPlan): Promise<Record<string, any>> {
    return until(async () => {
      const ids = await docker(['ps', '-q', '--no-trunc', '--filter',
        `label=awf.enclave.invocation=${invocation.invocationId}`]);
      for (const id of ids.split('\n').filter(Boolean)) {
        const inspected = JSON.parse(await docker(['inspect', id]))[0];
        if (!inspected.Name.endsWith('-probe') && inspected.State.Running) return inspected;
      }
      return undefined;
    }, 'actual audited workload container').catch((error) => {
      throw new Error(`${error.message}; actual daemon trace:\n${commandTrace.slice(-12).join('\n')}`);
    });
  }

  async function assertBoundary(inspected: Record<string, any>, kind: 'script' | 'agent') {
    expect(inspected.Config.User).toBe('65534:65534');
    expect(inspected.Config.Entrypoint).toEqual([
      `/usr/local/bin/run-enclave-${kind === 'script' ? 'script' : 'agent'}`,
    ]);
    expect(inspected.HostConfig).toMatchObject({
      ReadonlyRootfs: true, Memory: 128 * MiB, MemorySwap: 128 * MiB,
      NanoCpus: 500_000_000, PidsLimit: 48, CapDrop: ['ALL'],
      LogConfig: { Type: 'none' }, Privileged: false,
      ShmSize: kind === 'agent' ? 8 * MiB : 64 * MiB,
    });
    expect(inspected.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
    expect(inspected.HostConfig.Tmpfs['/tmp']).toBe('rw,noexec,nosuid,nodev,size=8m');
    if (kind === 'script') {
      expect(inspected.HostConfig.Tmpfs['/query']).toBe('rw,nosuid,nodev,size=8m,uid=65534,gid=65534,mode=0700');
    }
    expect(Object.keys(inspected.NetworkSettings.Networks)).toEqual([kind === 'script' ? 'none' : network]);
    expect(inspected.Mounts.find((m: any) => m.Destination === '/awf/seed')).toMatchObject({ RW: false });
    const writable = inspected.Mounts.filter((m: any) => m.RW);
    expect(writable.map((m: any) => m.Destination).sort()).toEqual(
      kind === 'script' ? ['/awf/out'] : ['/agent', '/awf/out', '/awf/session.jsonl'],
    );
    // Verify the host's actual superblock, not just Docker mount flags.
    expect(new Set(writable.map((m: any) => fs.statSync(m.Source).dev)).size).toBe(1);
    for (const mount of writable) {
      const ownership = fs.statSync(mount.Source);
      expect({ uid: ownership.uid, gid: ownership.gid, mode: ownership.mode & 0o777 }).toEqual({
        uid: 65534, gid: 65534, mode: mount.Destination === '/agent' ? 0o700 : 0o600,
      });
      const stat = fs.statfsSync(mount.Source);
      expect(Number(stat.type)).toBe(0x01021994);
      expect(Number(stat.blocks) * Number(stat.bsize)).toBe(8 * MiB);
    }
    const observed = JSON.parse(await docker([
      'exec', '--user', '65534:65534', inspected.Id, '/usr/bin/python3', '-c',
      'import json,os; ' +
      `paths=${JSON.stringify(writable.map((m: any) => m.Destination))}; ` +
      'print(json.dumps({"uid":os.geteuid(),"gid":os.getegid(),"mounts":' +
      '[{"path":p,"device":os.stat(p).st_dev,"inode":os.stat(p).st_ino,' +
      '"capacity":os.statvfs(p).f_blocks*os.statvfs(p).f_frsize} for p in paths]}))',
    ]));
    expect(observed).toMatchObject({ uid: 65534, gid: 65534 });
    for (const mount of writable) {
      const stat = fs.statSync(mount.Source);
      expect(observed.mounts.find((m: any) => m.path === mount.Destination)).toEqual({
        path: mount.Destination, device: stat.dev, inode: stat.ino, capacity: 8 * MiB,
      });
    }
  }

  async function assertGone(invocation: HostExecutorInvocationPlan) {
    expect(await docker(['ps', '-aq', '--filter', `label=awf.enclave.invocation=${invocation.invocationId}`])).toBe('');
    expect(fs.existsSync(invocation.invocationHostDir)).toBe(false);
    expect(fs.readdirSync(journalDir)).toEqual([]);
  }

  beforeAll(async () => {
    const capabilities = BigInt(`0x${/^CapEff:\s+([a-f0-9]+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1] || '0'}`);
    if (process.getuid?.() !== 0 || (capabilities & 0x200003n) !== 0x200003n) {
      throw new Error('Real host tmpfs acceptance requires root with CAP_SYS_ADMIN, CAP_CHOWN and CAP_DAC_OVERRIDE.');
    }
    expect(await docker(['version', '--format', '{{.Server.Os}}'])).toBe('linux');
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(seed, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(directory, 'invocations'), { mode: 0o700 });
    fs.writeFileSync(path.join(seed, 'private.txt'), sentinel, { mode: 0o444 });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(seed).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(seed, 'private.txt')).mode & 0o777).toBe(0o444);
    assertDockerHostPath(directory);
    await docker(['build', '--target', 'enclave-script', '-f', 'containers/enclave/Dockerfile', '-t', image, 'containers']);
    const fixture = '#!/usr/bin/python3\nexec(compile(open("/awf/task.txt").read(), "<confinement-fixture>", "exec"))\n';
    const dockerfile = [
      `FROM ${image}`,
      'COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent',
      `RUN python3 -c ${JSON.stringify(`from pathlib import Path; Path("/usr/local/bin/copilot").write_text(${JSON.stringify(fixture)})`)}`,
      'RUN chmod 0555 /usr/local/bin/run-enclave-agent /usr/local/bin/copilot && mkdir -p /agent',
      '',
    ].join('\n');
    await docker(['build', '-f', '-', '-t', agentImage, 'containers'], dockerfile);
    await docker(['network', 'create', '--internal', '--subnet', '172.31.0.0/24', network]);
    networkCreated = true;
    proxyId = await docker([
      'run', '-d', '--name', 'awf-enclave-agent-api-proxy',
      '--network', network, '--ip', '172.31.0.30', '--entrypoint', '/usr/bin/python3',
      image, '-c', 'import time; time.sleep(900)',
    ]);
  }, 240_000);

  afterAll(async () => {
    const errors: unknown[] = [];
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    for (const value of backends) {
      try { await value.close?.(); } catch (error) { errors.push(error); }
    }
    if (proxyId) {
      try { await docker(['rm', '-f', proxyId]); } catch (error) { errors.push(error); }
    }
    if (networkCreated) {
      try { await docker(['network', 'rm', network]); } catch (error) { errors.push(error); }
    }
    // Never recursively delete a surviving invocation mount after uncertain cleanup.
    if (fs.existsSync(directory)) {
      const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
      if (mounts.includes(directory)) throw new Error('Acceptance storage still mounted; retain evidence for recovery.');
      fs.rmSync(directory, { recursive: true, force: true });
    }
    if (errors.length) throw errors[0];
  }, 120_000);

  test('script: effective identity, readonly seed/rootfs, no networking, exact cgroups and bounded writable bind', async () => {
    const invocation = plan('script', confinement + `
assert os.listdir("/sys/class/net") == ["lo"]
s = socket.socket(); s.settimeout(0.2)
assert s.connect_ex(("1.1.1.1", 443)) != 0
Path("/awf/out").write_text('{"passed":true}')
print(${JSON.stringify(sentinel)})
time.sleep(2)
`);
    const pending = backend().execute(invocation, new AbortController().signal);
    await assertBoundary(await running(invocation), 'script');
    expect(await pending).toEqual({ outcome: 'success', result: '{"passed":true}' });
    expect(fs.readFileSync(path.join(seed, 'private.txt'), 'utf8')).toBe(sentinel);
    await assertGone(invocation);
  });

  test('real broker v2 client invokes Docker through the host listener and settles before releasing output', async () => {
    const invocation = plan('script', confinement + `
Path("/awf/out").write_text('{"passed":true}')
print(${JSON.stringify(sentinel)}, flush=True)
time.sleep(2)
`);
    const hostInvocation = {
      ...invocation,
      invocationHostDir: path.join(directory, 'invocations', 'script', invocation.invocationId),
    };
    const server = await startHostExecutorServer({
      runtimeDir: path.join(directory, 'ipc'),
      runState: {
        runId, seedsDir: path.dirname(seed), invocationsDir: path.join(directory, 'invocations'),
        journalDir: path.join(directory, 'protocol-journal'),
        entries: [{
          entryId: 'script', executorKind: 'script', timeoutMs: 30_000,
          staticSeedIds: [seedId], dynamicAgents: false,
        }],
      },
      backend: backend(),
    });
    try {
      const { createHostExecutorRunner } = require('../../containers/enclave/mcp-server/host-executor-runner');
      const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
      const events: Record<string, unknown>[] = [];
      const runner = createHostExecutorRunner({
        executorBackend: 'docker', executorTransport: 'host', entryId: 'script', runId,
        hostExecutorSocketPath: server.socketPath, hostExecutorCapabilityPath: server.capabilityPath,
      }, {
        nowMs: Date.now, pollMs: 50, requestTimeoutMs: 2_000,
        audit: { lifecycle: (_component: string, event: Record<string, unknown>) => events.push(event) },
      });
      await runner.assertAvailable();
      const pending = runner.runInvocation({
        invocationId: invocation.invocationId, seedId, payload: invocation.payload,
        schema, admissionId: invocation.admissionId, executorKind: 'script',
        deadlineMs: Date.now() + 30_000, signal: new AbortController().signal,
      });
      await assertBoundary(await running(hostInvocation), 'script');
      expect(await pending).toEqual({
        status: 'completed', timedOut: false, exitCode: 0, rawResult: '{"passed":true}',
      });
      expect(events).toContainEqual(expect.objectContaining({
        phase: 'settle', status: 'passed', outcome: 'success',
      }));
      const client = createHostExecutorClient({
        socketPath: server.socketPath, capabilityPath: server.capabilityPath, runId,
      });
      const status = await client.status({ entryId: 'script', invocationId: invocation.invocationId });
      expect(status).toMatchObject({ ok: true, state: 'settled', outcome: 'success' });
      expect(status).not.toHaveProperty('result');
      expect(JSON.stringify({ status, events })).not.toContain(sentinel);
      await assertGone(hostInvocation);
    } finally {
      await server.close();
    }
    expect(fs.existsSync(server.socketPath)).toBe(false);
    expect(fs.existsSync(server.capabilityPath)).toBe(false);
  });

  test('agent fixture: audited entrypoint, dedicated network only, bounded output/session/agent binds and private transcript', async () => {
    const invocation = plan('agent', confinement + `
assert sorted(os.listdir("/sys/class/net")) == ["eth0", "lo"]
s = socket.socket(); s.settimeout(0.2)
assert s.connect_ex(("1.1.1.1", 443)) != 0
assert os.statvfs("/dev/shm").f_blocks * os.statvfs("/dev/shm").f_frsize == 8 * 1024 * 1024
assert len({os.stat(p).st_dev for p in ["/agent", "/awf/out", "/awf/session.jsonl"]}) == 1
Path("/agent/fixture-ready").touch()
print(${JSON.stringify(sentinel)}, flush=True)
Path("/awf/out").write_text('{"passed":true}')
time.sleep(2)
`);
    const pending = backend().execute(invocation, new AbortController().signal);
    const inspected = await running(invocation);
    await assertBoundary(inspected, 'agent');
    const actualNetwork = JSON.parse(await docker(['network', 'inspect', network]))[0];
    expect(actualNetwork).toMatchObject({
      Internal: true, Driver: 'bridge', IPAM: { Config: [{ Subnet: '172.31.0.0/24' }] },
    });
    expect(Object.keys(actualNetwork.Containers).sort()).toEqual([proxyId, inspected.Id].sort());
    await until(async () => fs.existsSync(path.join(invocation.invocationHostDir, 'agent/fixture-ready')) || undefined, 'fixture engine');
    const result = await pending;
    const transcript = transcripts.get(invocation.invocationId)!;
    expect(transcript).not.toContain(sentinel);
    expect(transcript).toContain('"sensitivity":"redacted"');
    expect(transcript).toContain('"engine-result"');
    expect(result).toEqual({ outcome: 'success', result: '{"passed":true}' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    await assertGone(invocation);
  });

  test('concurrent sparse writers across output, session and agent exhaust ONE real allocation domain', async () => {
    const invocation = plan('agent', `
import errno, json, os, threading, time
from pathlib import Path
targets = ["/awf/out", "/awf/session.jsonl", "/agent/sparse"]
assert len({os.stat(p if p != targets[2] else "/agent").st_dev for p in targets}) == 1
capacity = 8 * 1024 * 1024
assert all(os.statvfs(p if p != targets[2] else "/agent").f_blocks * os.statvfs(p if p != targets[2] else "/agent").f_frsize == capacity for p in targets)
barrier = threading.Barrier(3)
written, errors = [0, 0, 0], [None, None, None]
def writer(index):
    fd = os.open(targets[index], os.O_WRONLY | os.O_CREAT, 0o600)
    try:
        os.pwrite(fd, b"x" * 4096, 0)
        written[index] += 4096
        barrier.wait()
        for offset in range(8192, 32 * 1024 * 1024, 8192):
            os.pwrite(fd, b"x" * 4096, offset)
            written[index] += 4096
    except OSError as error:
        errors[index] = error.errno
    finally:
        os.close(fd)
threads = [threading.Thread(target=writer, args=(i,)) for i in range(3)]
for t in threads: t.start()
for t in threads: t.join()
assert errors == [errno.ENOSPC] * 3, errors
assert all(count > 0 for count in written)
assert capacity - 256 * 1024 <= sum(written) <= capacity, written
assert all(os.stat(p).st_size < 64 * 1024 * 1024 for p in targets)
assert sum(os.stat(p).st_blocks * 512 for p in targets) <= capacity
assert sum(os.stat(p).st_blocks * 512 for p in targets) >= capacity - 256 * 1024
assert any(os.stat(p).st_size > os.stat(p).st_blocks * 512 for p in targets)
for p in targets:
    with open(p, "w"): pass
Path("/agent/sparse").unlink()
Path("/awf/out").write_text('{"passed":true}')
time.sleep(1)
`);
    const pending = backend().execute(invocation, new AbortController().signal);
    await assertBoundary(await running(invocation), 'agent');
    expect(await pending).toEqual({ outcome: 'success', result: '{"passed":true}' });
    await assertGone(invocation);
  });

  test('cancellation removes real container and mount without releasing a prewritten private result', async () => {
    const invocation = plan('script', `
import time
from pathlib import Path
Path("/awf/out").write_text(${JSON.stringify(sentinel)})
print(${JSON.stringify(sentinel)}, flush=True)
time.sleep(120)
`);
    const controller = new AbortController();
    const pending = backend().execute(invocation, controller.signal);
    await running(invocation);
    await until(async () => fs.readFileSync(path.join(invocation.invocationHostDir, 'out'), 'utf8') === sentinel || undefined, 'private output');
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ outcome: 'cancelled' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    await assertGone(invocation);
  });

  test('schema-invalid private output and raw script streams are not released', async () => {
    const invocation = plan('script', `
from pathlib import Path
import sys
Path("/awf/out").write_text(${JSON.stringify(sentinel)})
print(${JSON.stringify(sentinel)}, flush=True)
print(${JSON.stringify(sentinel)}, file=sys.stderr, flush=True)
`);
    const result = await backend().execute(invocation, new AbortController().signal);
    expect(result).toEqual({ outcome: 'schema-failure' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(commandTrace.join('\\n')).not.toContain(sentinel);
    await assertGone(invocation);
  });

  test('kernel memory exhaustion rejects even a prewritten schema-valid result', async () => {
    const invocation = plan('script', `
from pathlib import Path
Path("/awf/out").write_text('{"passed":true}')
allocation = bytearray(256 * 1024 * 1024)
`);
    const result = await backend().execute(invocation, new AbortController().signal);
    expect(result).toEqual({ outcome: 'executor-failure' });
    expect(exitedStates.get(invocation.invocationId)).toMatchObject({ OOMKilled: true, ExitCode: 137 });
    await assertGone(invocation);
  });

  test('kernel PID limit rejects additional real forks with EAGAIN', async () => {
    const invocation = plan('script', `
import errno, os, signal, time
from pathlib import Path
assert Path("/sys/fs/cgroup/pids.max").read_text().strip() == "48"
children, rejected = [], False
try:
    for _ in range(128):
        try:
            child = os.fork()
        except OSError as error:
            assert error.errno == errno.EAGAIN
            rejected = True
            break
        if child == 0:
            time.sleep(30)
            os._exit(0)
        children.append(child)
    assert rejected and 0 < len(children) < 48
finally:
    for child in children: os.kill(child, signal.SIGKILL)
    for child in children: os.waitpid(child, 0)
Path("/awf/out").write_text('{"passed":true}')
`);
    expect(await backend().execute(invocation, new AbortController().signal))
      .toEqual({ outcome: 'success', result: '{"passed":true}' });
    await assertGone(invocation);
  });

  test('a split mount namespace with the same source pathname fails closed before private workload launch', async () => {
    const invocation = plan('script', `raise RuntimeError(${JSON.stringify(sentinel)})`);
    const code = `
const {execFile}=require("child_process");
const {createDockerHostEnclaveExecutor}=require(${JSON.stringify(path.join(root, 'src/enclave/docker-host-executor.ts'))});
const options=${JSON.stringify(options())};
let probeCreated=false, workloadCreated=false;
options.dockerCommand=(args)=>new Promise(resolve=>{
  execFile("docker",args,{timeout:30000,maxBuffer:128*1024},(error,stdout)=>{
    const exitCode=error ? typeof error.code==="number" ? error.code : 1 : 0;
    if(args[0]==="create" && exitCode===0){
      if(args[args.indexOf("--name")+1].endsWith("-probe")) probeCreated=true;
      else workloadCreated=true;
    }
    resolve({exitCode,stdout});
  });
});
const backend=createDockerHostEnclaveExecutor(options);
backend.execute(${JSON.stringify(invocation)},new AbortController().signal).then(async result=>{
  await backend.close();
  console.log(JSON.stringify({result,probeCreated,workloadCreated}));
}).catch(()=>process.exit(1));
`;
    const output = await new Promise<string>((resolve, reject) => {
      execFile('unshare', [
        '--mount', '--propagation', 'private', '--',
        process.execPath, '--require', 'tsx/cjs', '--eval', code,
      ], { cwd: root, env: subprocessEnv, timeout: 60_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
        if (error) reject(new Error(`Real mount-namespace acceptance failed: ${stderr}`));
        else resolve(stdout);
      });
    });
    expect(JSON.parse(output)).toEqual({
      result: { outcome: 'executor-failure' }, probeCreated: true, workloadCreated: false,
    });
    expect(output).not.toContain(sentinel);
    await assertGone(invocation);
  });

  test('SIGKILL orphan is reconciled from durable intent before the next backend starts', async () => {
    const invocation = plan('script', 'import time; time.sleep(120)');
    const code = `const {createDockerHostEnclaveExecutor}=require(${JSON.stringify(path.join(root, 'src/enclave/docker-host-executor.ts'))});` +
      `createDockerHostEnclaveExecutor(${JSON.stringify(options())}).execute(${JSON.stringify(invocation)},new AbortController().signal).then(()=>process.exit(0));`;
    const child = spawn(process.execPath, ['--require', 'tsx/cjs', '--eval', code], {
      cwd: root, env: subprocessEnv, stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let childOutput = '';
    child.stdout!.on('data', (chunk) => { childOutput += chunk; });
    child.stderr!.on('data', (chunk) => { childOutput += chunk; });
    const inspected = await running(invocation);
    expect(child.kill('SIGKILL')).toBe(true);
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    expect(JSON.parse(await docker(['inspect', inspected.Id]))[0].State.Running).toBe(true);
    expect(fs.readdirSync(journalDir)).toHaveLength(1);
    expect(childOutput).not.toContain(sentinel);
    const restarted = backend();
    await restarted.prepare();
    await restarted.close?.();
    await assertGone(invocation);
  });
});
