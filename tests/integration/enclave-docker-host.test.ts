/**
 * Real host-adapter acceptance, deliberately separate from mocked runner tests.
 * Public diagnostics acceptance runs WITHOUT sudo after installing the
 * version-matched storage helper:
 * REPO="$(pwd)"
 * mkdir -p "$REPO/.git/enclave-docker-host-cache"
 * env TMPDIR="$REPO/.git/enclave-docker-host-cache" \
 *   NODE_DISABLE_COMPILE_CACHE=1 TSX_DISABLE_CACHE=1 AWF_DOCKER_HOST_STORAGE_HELPER_ACCEPTANCE=1 \
 *   node "$REPO/node_modules/jest/bin/jest.js" \
 *   --config "$REPO/tests/setup/jest.integration.config.js" \
 *   --cacheDirectory "$REPO/.git/enclave-docker-host-cache" \
 *   --runInBand "$REPO/tests/integration/enclave-docker-host.test.ts" \
 *   --testNamePattern='public diagnostics:'
 * The agent image substitutes only Copilot, not the audited Python entrypoint.
 * This exercises confinement, NOT a live Copilot model or provider.
 * Omit the name selector for the full existing fixture matrix. The separate
 * AWF_DOCKER_HOST_ACCEPTANCE=1 mode requires root and direct CAP_SYS_ADMIN.
 */
import { afterAll, beforeAll, describe, expect, test } from '@jest/globals';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { serializeFiniteSchema } from '../../src/bounded-execution/finite-schema';
import { finiteSchemaHash } from '../../src/bounded-execution/schema-hash';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import { buildEnclaveMcpService } from '../../src/services/enclave-mcp-service';
import { parseImageTag } from '../../src/image-tag';
import { resolveEnclavePaths } from '../../src/enclave/paths';
import { ENCLAVE_MCP_CONTROL_ALIAS, ENCLAVE_MCP_CONTROL_NETWORK } from '../../src/enclave/network';
import { assertPersistentDebugArtifactsIsolated } from '../../src/enclave/mount-policy';
import { resolveDockerPublicEnclaveDebugPaths } from '../../src/enclave/public-debug';
import { PUBLIC_ENCLAVE_ARTIFACT_NAMES, PUBLIC_ENCLAVE_CAPTURE_BYTES } from '../../src/enclave/public-debug-artifacts';
import type { WrapperConfig } from '../../src/types';
import {
  createDockerHostEnclaveExecutor, type DockerHostExecutorEntry, type DockerHostEnclaveExecutorBackend,
} from '../../src/enclave/docker-host-executor';
import { assertDockerHostPath } from '../../src/enclave/docker-host-storage';
import {
  assertDockerStorageHelperAvailable, dockerHelperStorageTarget, hasDockerHostMountCapability,
} from '../../src/enclave/docker-storage-helper';
import type {
  HostEnclaveExecutorBackend, HostExecutorInvocationPlan,
} from '../../src/enclave/host-executor-server';
import { startHostExecutorServer } from '../../src/enclave/host-executor-server';
import { releaseSeedPermissions, stageEnclaveSeeds, type GitRunner } from '../../src/enclave/staging';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { deriveEnclaveContainerSpec } = require('../../containers/enclave/agent-executor/enclave-runner-spec.js');

const helperAcceptance = process.env.AWF_DOCKER_HOST_STORAGE_HELPER_ACCEPTANCE === '1';
const enabled = process.env.AWF_DOCKER_HOST_ACCEPTANCE === '1' || helperAcceptance;
const acceptance = enabled ? describe : describe.skip;
const privilegedAcceptance = helperAcceptance ? test.skip : test;
const root = path.resolve(__dirname, '../..');
const fixtureHome = path.join(root, '.git/enclave-docker-host-cache', `isolated-home-${process.pid}`);
const subprocessEnv = {
  PATH: process.env.PATH || '/usr/bin:/bin', HOME: fixtureHome,
  DOCKER_CONFIG: path.join(fixtureHome, 'docker-config'),
  LANG: 'C.UTF-8', DOCKER_HOST: process.env.DOCKER_HOST,
  TMPDIR: path.join(root, '.git/enclave-docker-host-cache'),
  NODE_DISABLE_COMPILE_CACHE: '1', TSX_DISABLE_CACHE: '1',
};
const image = 'awf-enclave-script:host-acceptance';
const agentImage = 'awf-enclave-agent:host-acceptance-fixture';
const brokerImage = 'awf-enclave-mcp-server:host-acceptance';
const MiB = 1024 * 1024;
const sentinel = 'PRIVATE-ACCEPTANCE-CONTENT-MUST-NOT-ESCAPE';
const schema = {
  type: 'object', fields: [{ name: 'passed', schema: { type: 'boolean' } }],
} as const;

function docker(args: string[], input?: string, timeout = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('docker', args, {
      cwd: root, env: subprocessEnv, timeout, maxBuffer: 1024 * 1024,
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
mounts = {fields[1]: fields[3].split(",") for fields in
          (line.split() for line in Path("/proc/mounts").read_text().splitlines())}
assert "ro" in mounts["/"] and "ro" in mounts["/awf/seed"]
for target in ["/awf/seed/private.txt", "/etc/passwd"]:
    try:
        with open(target, "ab") as f: f.write(b"x")
        raise AssertionError("readonly mutation succeeded")
    except OSError as e:
        assert e.errno in (errno.EROFS, errno.EACCES)
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
  let directory = '';
  const seedId = 'a'.repeat(32);
  let seed = '';
  let journalDir = '';
  const network = `awf-enclave-acceptance-${randomBytes(5).toString('hex')}`;
  const backends: HostEnclaveExecutorBackend[] = [];
  const children: ChildProcess[] = [];
  const commandTrace: string[] = [];
  const transcripts = new Map<string, string>();
  const exitedStates = new Map<string, { OOMKilled: boolean; ExitCode: number }>();
  const sessionContainers = new Map<string, string>();
  const debugDirectories = new Set<string>();
  const helperStorage = !hasDockerHostMountCapability();
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

  function backend(
    kinds: readonly ('script' | 'agent')[] = ['script', 'agent'],
    publicDebug = false,
    configure: (value: DockerHostExecutorEntry) => DockerHostExecutorEntry = (value) => value,
  ): DockerHostEnclaveExecutorBackend {
    const value = createDockerHostEnclaveExecutor({
      ...options(),
      entries: kinds.map((kind) => configure(entry(kind))),
      publicDebug,
      // Observe actual daemon commands; no Docker response is mocked or rewritten.
      dockerCommand: async (args, signal) => {
        if (args[0] === 'rm') {
          const id = args[2];
          const invocation = sessionContainers.get(id);
          if (invocation) {
            const copy = path.join(directory, `session-${invocation}`);
            await docker(['cp', `${id}:/awf/session.jsonl`, copy]);
            transcripts.set(invocation, fs.readFileSync(copy, 'utf8'));
            fs.unlinkSync(copy);
            sessionContainers.delete(id);
          }
        }
        return new Promise((resolve) => {
        execFile('docker', [...args], {
          cwd: root, env: subprocessEnv, signal, timeout: 30_000, maxBuffer: 1024 * 1024,
        }, (error, stdout, stderr) => {
          const exitCode = error ? typeof error.code === 'number' ? error.code : 1 : 0;
          commandTrace.push(`${JSON.stringify(args)} => ${exitCode} ${stderr}`);
          if (args[0] === 'container' && args[1] === 'inspect' && exitCode === 0) {
            const inspected = JSON.parse(stdout)[0];
            if (inspected.Mounts.some((mount: { Destination: string }) => mount.Destination === '/awf/session.jsonl')) {
              sessionContainers.set(inspected.Id, inspected.Config.Labels['awf.enclave.invocation']);
            }
            if (inspected.State.Status === 'exited' && !inspected.Name.endsWith('-probe')) {
              exitedStates.set(inspected.Config.Labels['awf.enclave.invocation'], inspected.State);
            }
          }
          const imageUnavailable = error?.code === 1
            ? /^Error response from daemon: No such image: ([^\r\n]+)\r?\n?$/.exec(stderr)?.[1] : undefined;
          resolve({ exitCode, stdout, ...(imageUnavailable ? { imageUnavailable } : {}) });
        });
        });
      },
    });
    backends.push(value);
    return value;
  }

  function storagePath(invocation: HostExecutorInvocationPlan): string {
    return helperStorage
      ? dockerHelperStorageTarget(invocation.runId, invocation.entryId, invocation.invocationId)
      : invocation.invocationHostDir;
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

  async function assertBoundary(inspected: Record<string, any>, kind: 'script' | 'agent', publicDebug = false) {
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
      [...(kind === 'script' ? ['/awf/out'] : ['/agent', '/awf/out', '/awf/session.jsonl']),
        ...(publicDebug ? ['/awf/stdout.log', '/awf/stderr.log'] : [])].sort(),
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
    expect(fs.existsSync(storagePath(invocation))).toBe(false);
    expect(fs.readdirSync(journalDir)).toEqual([]);
  }

  beforeAll(async () => {
    const capabilities = BigInt(`0x${/^CapEff:\s+([a-f0-9]+)/m.exec(fs.readFileSync('/proc/self/status', 'utf8'))?.[1] || '0'}`);
    if (helperAcceptance) {
      if (!helperStorage || process.getuid?.() === 0) throw new Error('Helper acceptance must run as an unprivileged AWF process.');
      assertDockerStorageHelperAvailable();
    } else if (process.getuid?.() !== 0 || (capabilities & 0x200003n) !== 0x200003n) {
      throw new Error('Real host tmpfs acceptance requires root with CAP_SYS_ADMIN, CAP_CHOWN and CAP_DAC_OVERRIDE.');
    }
    fs.mkdirSync(fixtureHome, { recursive: true, mode: 0o700 });
    expect(await docker(['version', '--format', '{{.Server.Os}}'])).toBe('linux');
    const fixtureParent = root;
    directory = fs.mkdtempSync(path.join(fixtureParent, '.e-'));
    seed = path.join(directory, 'seeds', seedId);
    journalDir = path.join(directory, 'journal');
    fs.mkdirSync(seed, { recursive: true, mode: 0o755 });
    fs.mkdirSync(path.join(directory, 'invocations'), { mode: 0o700 });
    fs.writeFileSync(path.join(seed, 'private.txt'), sentinel, { mode: 0o444 });
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(seed).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(seed, 'private.txt')).mode & 0o777).toBe(0o444);
    assertDockerHostPath(directory);
    const buildContext = path.join(directory, 'audited-build-context');
    fs.mkdirSync(path.join(buildContext, 'enclave'), { recursive: true, mode: 0o700 });
    for (const filename of ['script-entrypoint.py', 'agent-entrypoint.py', 'public_debug_capture.py', 'seccomp.json']) {
      const source = path.join(root, 'containers/enclave', filename);
      if (!fs.lstatSync(source).isFile()) throw new Error('Audited fixture source must be a regular file');
      fs.copyFileSync(source, path.join(buildContext, 'enclave', filename));
    }
    for (const sourceDirectory of [
      'bounded-execution', 'enclave/script-executor', 'enclave/agent-executor', 'enclave/mcp-server',
    ]) {
      fs.cpSync(path.join(root, 'containers', sourceDirectory), path.join(buildContext, sourceDirectory), {
        recursive: true,
        filter: (filename) => {
          const stat = fs.lstatSync(filename);
          if (stat.isSymbolicLink()) throw new Error('Audited fixture build context must not contain symlinks');
          return stat.isDirectory() || (stat.isFile() && /\.(js|json)$/.test(filename));
        },
      });
    }
    const sourceDockerfile = fs.readFileSync(path.join(root, 'containers/enclave/Dockerfile'), 'utf8');
    const scriptBase = /^FROM (\S+) AS enclave-script$/m.exec(sourceDockerfile)![1];
    await docker(['build', '-f', '-', '-t', image, buildContext], [
      `FROM ${scriptBase}`,
      'COPY enclave/script-entrypoint.py /usr/local/bin/run-enclave-script',
      'COPY enclave/public_debug_capture.py /usr/local/bin/public_debug_capture.py',
      'RUN chmod 0555 /usr/local/bin/run-enclave-script && mkdir -p /script /awf/seed && ln -s /usr/local/bin/python3 /usr/bin/python3',
    ].join('\n'));
    const fixture = '#!/usr/bin/python3\n' +
      'task=open("/awf/task.txt").read().split("\\n\\nGitHub MCP scope (authoritative;",1)[0]\n' +
      'exec(compile(task, "<confinement-fixture>", "exec"))\n';
    const dockerfile = [
      `FROM ${image}`,
      'COPY enclave/agent-entrypoint.py /usr/local/bin/run-enclave-agent',
      'COPY enclave/public_debug_capture.py /usr/local/bin/public_debug_capture.py',
      `RUN python3 -c ${JSON.stringify(`from pathlib import Path; Path("/usr/local/bin/copilot").write_text(${JSON.stringify(fixture)})`)}`,
      'RUN chmod 0555 /usr/local/bin/run-enclave-agent /usr/local/bin/copilot && mkdir -p /agent /run/awf-enclave-github',
      '',
    ].join('\n');
    await docker(['build', '-f', '-', '-t', agentImage, buildContext], dockerfile);
    const brokerBase = /^FROM (\S+) AS enclave-mcp-server$/m.exec(sourceDockerfile)![1];
    await docker(['build', '-f', '-', '-t', brokerImage, buildContext], [
      `FROM ${brokerBase}`,
      'WORKDIR /opt/awf/enclave/mcp-server',
      'COPY bounded-execution/ /opt/awf/bounded-execution/',
      'COPY enclave/script-executor/ /opt/awf/enclave/script-executor/',
      'COPY enclave/agent-executor/ /opt/awf/enclave/agent-executor/',
      'COPY enclave/mcp-server/ /opt/awf/enclave/mcp-server/',
      'COPY enclave/seccomp.json /opt/awf/script-seccomp.json',
      'COPY enclave/seccomp.json /opt/awf/enclave-seccomp.json',
      'RUN chmod -R a-w /opt/awf && mkdir -p /srv/awf/seeds /srv/awf/work /run/awf-enclave-mcp /run/awf-enclave-mcp-control /var/log/awf-enclave',
      'ENTRYPOINT ["node","/opt/awf/enclave/mcp-server/server.js"]',
    ].join('\n'));
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
    if (errors.length) throw errors[0];
    for (const debugDirectory of debugDirectories) fs.rmSync(debugDirectory, { recursive: true, force: true });
    // Never delete recovery journals while helper allocations or mounts may remain.
    if (directory && fs.existsSync(directory)) {
      const mounts = fs.readFileSync('/proc/self/mountinfo', 'utf8');
      if (mounts.includes(directory)) throw new Error('Acceptance storage still mounted; retain evidence for recovery.');
      if (helperStorage && ['script', 'agent'].some((entryId) => fs.existsSync(path.dirname(
        dockerHelperStorageTarget(runId, entryId, 'a'.repeat(16)),
      )))) throw new Error('Acceptance helper allocation remains; retain journals for recovery.');
      fs.rmSync(directory, { recursive: true, force: true });
    }
    fs.rmSync(fixtureHome, { recursive: true, force: true });
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

  test.each(['script', 'agent', 'both'] as const)(
    'generated %s broker container executes through host IPC without Docker or seed-tree custody',
    async (mode) => {
      const kinds: ('script' | 'agent')[] = mode === 'both' ? ['script', 'agent'] : [mode];
      const workDir = path.join(directory, `broker-${mode}`);
      fs.mkdirSync(workDir, { mode: 0o700 });
      const paths = resolveEnclavePaths(workDir);
      const config: WrapperConfig = {
        workDir, enableApiProxy: true, allowedDomains: [],
        agentCommand: 'true', logLevel: 'error', keepContainers: false,
        enclaves: normalizeEnclavesConfig(kinds.map((kind) => ({
          ...(kind === 'script' ? { script: {} } : { agent: { model: 'confinement-fixture' } }),
          image: kind === 'script' ? image : agentImage,
          timeout: 10, repos: [{ repo: 'fixture/private', sensitivity: 'internal' }],
        }))),
      };
      fs.mkdirSync(paths.root, { mode: 0o700 });
      fs.mkdirSync(paths.runDir, { recursive: true, mode: 0o700 });
      for (const target of [paths.controlDir, paths.auditDir]) fs.mkdirSync(target, { mode: 0o700 });
      fs.writeFileSync(paths.runIdPath, runId, { mode: 0o600 });
      fs.writeFileSync(paths.capabilityPath, randomBytes(32).toString('hex'), { mode: 0o600 });
      fs.writeFileSync(paths.seedMapPath, JSON.stringify({
        version: 2, runId, seeds: [{ repo: 'fixture/private', seedId, sensitivity: 'internal' }],
      }), { mode: 0o600 });
      const server = await startHostExecutorServer({
        runtimeDir: paths.hostExecutorDir,
        runState: {
          runId, seedsDir: path.dirname(seed), invocationsDir: path.join(workDir, 'invocations'),
          journalDir: path.join(workDir, 'protocol-journal'),
          entries: kinds.map((kind) => ({
            entryId: kind, executorKind: kind, timeoutMs: 10_000, staticSeedIds: [seedId], dynamicAgents: false,
          })),
        },
        backend: backend(kinds),
      });
      const project = `awf-broker-${randomBytes(6).toString('hex')}`;
      const controlNetwork = `${project}-control`;
      const composePath = path.join(workDir, 'compose.json');
      const compose = ['compose', '-p', project, '-f', composePath];
      const rpcContainers = new Set<string>();
      const cleanupBroker = async () => {
        const cleanupErrors: unknown[] = [];
        try { await server.close(); } catch (error) { cleanupErrors.push(error); }
        for (const name of rpcContainers) {
          try {
            const remaining = await docker(['ps', '-aq', '--filter', `name=^/${name}$`], undefined, 10_000);
            if (remaining) await docker(['rm', '-f', name], undefined, 10_000);
          } catch (error) { cleanupErrors.push(error); }
        }
        if (fs.existsSync(composePath)) {
          try { await docker([...compose, 'down', '--volumes', '--remove-orphans'], undefined, 30_000); }
          catch (error) { cleanupErrors.push(error); }
        }
        if (cleanupErrors.length) throw cleanupErrors[0];
        if (fs.readFileSync('/proc/self/mountinfo', 'utf8').includes(workDir)) {
          throw new Error('Broker acceptance storage remains mounted; retain private recovery state');
        }
        fs.rmSync(paths.root, { recursive: true });
        fs.rmSync(paths.ingressRoot, { recursive: true });
      };
      try {
        const { service } = buildEnclaveMcpService({
          config,
          imageConfig: {
            useGHCR: true, registry: 'unused.invalid', parsedTag: parseImageTag('latest'),
            projectRoot: root, resolveImage: () => brokerImage,
          },
          networkConfig: {
            subnet: '172.30.0.0/24', squidIp: '172.30.0.10', agentIp: '172.30.0.20', proxyIp: '172.30.0.30',
          },
        });
        // Images and the dedicated proxy are real, already-running fixtures.
        // This gate covers broker wiring, not production dependency startup.
        fs.writeFileSync(composePath, JSON.stringify({
          services: { broker: { ...service, container_name: `${project}-broker`, depends_on: undefined } },
          networks: { [ENCLAVE_MCP_CONTROL_NETWORK]: { name: controlNetwork, internal: true } },
        }), { mode: 0o600 });
        await docker([...compose, 'up', '-d', '--wait', '--wait-timeout', '60'], undefined, 75_000);
        const inspected = JSON.parse(await docker(['inspect', `${project}-broker`], undefined, 10_000))[0];
        expect(Object.keys(inspected.NetworkSettings.Networks)).toEqual([controlNetwork]);
        const brokerNetwork = inspected.NetworkSettings.Networks[controlNetwork];
        expect(brokerNetwork.Aliases).toContain(ENCLAVE_MCP_CONTROL_ALIAS);
        const destinations = inspected.Mounts.map((mount: { Destination: string }) => mount.Destination);
        expect(destinations).toContain('/run/awf-enclave-host-executor');
        expect(destinations).not.toContain('/var/run/docker.sock');
        expect(destinations).not.toContain('/srv/awf/seeds');
        expect(destinations).not.toContain('/srv/awf/work');
        expect(inspected.Mounts.find((mount: { Destination: string }) => mount.Destination === '/run/awf-enclave-host-executor'))
          .toMatchObject({ RW: false });
        expect(await docker(['exec', `${project}-broker`, 'node', '-e',
          'const fs=require("fs");' +
          `for(const p of ${JSON.stringify(['/var/run/docker.sock', seed, `/srv/awf/seeds/${seedId}`])})` +
          '{if(fs.existsSync(p))process.exit(1)};' +
          'for(const p of ["/srv/awf/seeds","/srv/awf/work"])' +
          '{if(fs.readdirSync(p).length)process.exit(1)};console.log("no-private-launch-custody")',
        ], undefined, 10_000)).toBe('no-private-launch-custody');

        const rpc = async (method: string, params: Record<string, unknown>, authorized = true) => {
          const request = { jsonrpc: '2.0', id: 1, method, params };
          const timeout = method === 'tools/call' ? 75_000 : 10_000;
          const script = 'const fs=require("fs");' +
            `fetch("http://${brokerNetwork.IPAddress}:8080/mcp",{method:"POST",headers:{` +
            '"content-type":"application/json",' +
            (authorized ? 'authorization:"Bearer "+fs.readFileSync("/auth-token","utf8"),' : '') +
            // The 10-second workload budget pads to the 60-second public timing bucket.
            `},body:JSON.stringify(${JSON.stringify(request)}),signal:AbortSignal.timeout(${timeout})})` +
            '.then(async r=>console.log(JSON.stringify({status:r.status,body:await r.json()})))' +
            `.catch(error=>{console.error(${JSON.stringify(method)},error.cause?.code||error.name);process.exit(1)})`;
          const name = `${project}-rpc-${randomBytes(4).toString('hex')}`;
          rpcContainers.add(name);
          const response = await docker([
            'run', '--rm', '--name', name, '--network', controlNetwork, '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges:true', '--read-only',
            '-v', `${paths.capabilityPath}:/auth-token:ro`,
            '--entrypoint', 'node', brokerImage, '-e', script,
          ], undefined, timeout + 5_000);
          rpcContainers.delete(name);
          return JSON.parse(response);
        };
        expect(await rpc('tools/list', {}, false)).toMatchObject({ status: 401 });
        const listed = await rpc('tools/list', {});
        expect(listed.status).toBe(200);
        expect(listed.body.result.tools.map((tool: { name: string }) => tool.name).sort())
          .toEqual(kinds.map((kind) => `enclave_run_${kind}`).sort());
        for (const kind of kinds) {
          const payload = `
from pathlib import Path
assert Path("/awf/seed/private.txt").read_text() == ${JSON.stringify(sentinel)}
Path("/awf/out").write_text('{"passed":true}')
print(${JSON.stringify(sentinel)}, flush=True)
`;
          const response = await rpc('tools/call', {
            name: `enclave_run_${kind}`,
            arguments: {
              privateRepo: 'fixture/private',
              schema: serializeFiniteSchema(schema),
              [kind === 'script' ? 'script' : 'prompt']: payload,
            },
          });
          expect(response.status).toBe(200);
          expect(response.body.error).toBeUndefined();
          expect(response.body.result.isError).not.toBe(true);
          expect(JSON.stringify(response)).not.toContain(sentinel);
          expect(response.body.result.structuredContent).toEqual({ status: 'ok', result: { passed: true } });
          expect(response.body.result.content).toEqual([{
            type: 'text', text: '{"status":"ok","result":{"passed":true}}',
          }]);
        }
        expect(fs.readdirSync(journalDir)).toEqual([]);
        expect(await docker(['ps', '-aq', '--filter', `label=awf.enclave.run=${runId}`], undefined, 10_000)).toBe('');
        const audit = fs.readdirSync(paths.auditDir).filter((name) => name.endsWith('.jsonl'))
          .map((name) => fs.readFileSync(path.join(paths.auditDir, name), 'utf8')).join('\n');
        expect(audit).not.toContain(sentinel);
      } finally {
        await cleanupBroker();
      }
    },
    480_000,
  );

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
    await until(async () => {
      try { await docker(['exec', '--user', '65534:65534', inspected.Id, 'test', '-e', '/agent/fixture-ready']); return true; }
      catch { return undefined; }
    }, 'fixture engine');
    const result = await pending;
    const transcript = transcripts.get(invocation.invocationId)!;
    expect(transcript).not.toContain(sentinel);
    expect(transcript).toContain('"sensitivity":"redacted"');
    expect(transcript).toContain('"engine-result"');
    expect(result).toEqual({ outcome: 'success', result: '{"passed":true}' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    expect(fs.existsSync(path.join(
      resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId,
    ))).toBe(false);
    await assertGone(invocation);
  });

  test.each([
    ['script', false], ['script', true], ['agent', false], ['agent', true],
  ] as const)('public diagnostics: %s %s retains redacted bounded evidence without changing canonical results', async (kind, fails) => {
    const syntheticToken = 'synthetic-fixture-token:"quoted"/value';
    const secretForms = [syntheticToken, JSON.stringify(syntheticToken).slice(1, -1),
      encodeURIComponent(syntheticToken), Buffer.from(syntheticToken).toString('base64')];
    const marker = `PUBLIC-DIAGNOSTIC-${kind}-${fails ? 'failure' : 'success'}`;
    const launchArgs: string[] = deriveEnclaveContainerSpec({
      config: entry('agent').config, runId, invocationId: 'b'.repeat(32), seedId,
    }).launchArgs;
    const dummyCopilotToken = launchArgs.find(value => value.startsWith('COPILOT_GITHUB_TOKEN='))!
      .slice('COPILOT_GITHUB_TOKEN='.length);
    const invocation = plan(kind, `
import json, os, sys, time
from pathlib import Path
assert os.geteuid() == 65534
assert ${JSON.stringify(syntheticToken)} not in json.dumps(dict(os.environ))
assert not any(name in os.environ for name in [
    "GITHUB_TOKEN", "GH_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
assert os.environ.get("COPILOT_GITHUB_TOKEN") == ${kind === 'agent' ? JSON.stringify(dummyCopilotToken) : 'None'}
assert os.environ["AWF_ENCLAVE_DEBUG_PUBLIC"] == "true"
print(${JSON.stringify(marker)}, flush=True)
print(${JSON.stringify(secretForms.join('\n'))}, flush=True)
print("Authorization: Bearer " + "not-a-live-fixture-credential", file=sys.stderr, flush=True)
print(${JSON.stringify(marker + '-stderr')}, file=sys.stderr, flush=True)
if "--log-dir" in sys.argv:
    Path(sys.argv[sys.argv.index("--log-dir") + 1], "fixture.log").write_text(
        ${JSON.stringify(marker + '-copilot-diagnostic\n' + syntheticToken)})
Path("/awf/out").write_text(' { "passed" : true } \\n')
time.sleep(2)
${fails ? 'sys.exit(7)' : ''}
`);
    const debugDirectory = path.join(resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId);
    debugDirectories.add(debugDirectory);
    const executor = backend([kind], true, (value) => ({
      ...value, config: { ...value.config, syntheticToken },
    }));
    const pending = executor.execute(invocation, new AbortController().signal);
    const inspected = await running(invocation);
    await assertBoundary(inspected, kind, true);
    for (const mount of inspected.Mounts) {
      expect(path.relative(mount.Source, debugDirectory).startsWith(`..${path.sep}`)).toBe(true);
    }
    const result = await pending;
    expect(result).toEqual(fails
      ? { outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true }
      : { outcome: 'success', result: '{"passed":true}' });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(syntheticToken);
    expect(fs.readdirSync(debugDirectory).sort()).toEqual([...PUBLIC_ENCLAVE_ARTIFACT_NAMES].sort());
    const directoryStat = fs.lstatSync(debugDirectory);
    expect({ uid: directoryStat.uid, mode: directoryStat.mode & 0o777 }).toEqual({
      uid: process.getuid?.(), mode: 0o700,
    });
    const artifacts = PUBLIC_ENCLAVE_ARTIFACT_NAMES.map((name) => {
      const filename = path.join(debugDirectory, name);
      const stat = fs.lstatSync(filename);
      expect(stat.isFile()).toBe(true);
      expect({ uid: stat.uid, mode: stat.mode & 0o777, nlink: stat.nlink }).toEqual({
        uid: process.getuid?.(), mode: 0o600, nlink: 1,
      });
      expect(stat.size).toBeLessThanOrEqual(PUBLIC_ENCLAVE_CAPTURE_BYTES);
      return fs.readFileSync(filename, 'utf8');
    });
    const retained = artifacts.join('\n');
    expect(retained).toContain(marker);
    expect(retained).toContain('[REDACTED]');
    for (const secret of [...secretForms, 'not-a-live-fixture-credential']) {
      expect(retained).not.toContain(secret);
    }
    const diagnostics = JSON.parse(fs.readFileSync(path.join(debugDirectory, 'diagnostics.json'), 'utf8'));
    expect(diagnostics).toMatchObject({
      version: 1, runtime: 'docker', runId, invocationId: invocation.invocationId, entryId: kind,
      executorKind: kind, stage: fails ? 'execution' : 'complete', failure: fails ? 'workload-exit' : 'none',
      workloadStopped: true, workloadLaunched: true, stopProof: 'verified',
      streams: { stdout: 'captured', stderr: 'captured', session: kind === 'agent' ? 'captured' : 'not-applicable' },
    });
    const exited = exitedStates.get(invocation.invocationId);
    expect(exited).toBeDefined();
    expect(diagnostics.exitCode).toBe(exited!.ExitCode);
    expect(diagnostics.exitCode === 0).toBe(!fails);
    expect(diagnostics.backendEvidence.dockerInspect).toMatchObject({
      status: 'captured', running: false, exitCode: exited!.ExitCode, oomKilled: exited!.OOMKilled,
    });
    expect(diagnostics.backendEvidence.vmCounters.status).toBe('not-applicable');
    expect(diagnostics.backendEvidence.network.status).toBe('unavailable');
    expect(diagnostics.streamCoverage).toMatchObject({
      stdout: { artifactSource: 'workload-file', agentSession: kind === 'agent' ? 'captured' : 'unavailable' },
      stderr: { artifactSource: 'workload-file', agentSession: kind === 'agent' ? 'captured' : 'unavailable' },
      copilotDiagnostics: kind === 'agent' && fails ? 'agent-session' : 'unavailable',
    });
    for (const stage of ['storage-preparation', 'storage-probe', 'workload-create', 'workload-start', 'workload-exit']) {
      expect(diagnostics.stages).toContainEqual(expect.objectContaining({ stage, status: 'succeeded' }));
    }
    expect(diagnostics.stages.length).toBeLessThanOrEqual(64);
    expect(diagnostics).not.toHaveProperty('cleanupFailure');
    if (fails) {
      expect(diagnostics.primaryFailure).toMatchObject({ stage: 'workload-exit', category: 'workload-exit' });
    } else {
      expect(diagnostics).not.toHaveProperty('primaryFailure');
      expect(diagnostics.stages).toContainEqual(expect.objectContaining({
        stage: 'output-validation', status: 'succeeded',
      }));
    }
    if (kind === 'agent') {
      const session = fs.readFileSync(path.join(debugDirectory, 'enclave-session.log'), 'utf8');
      expect(session).toContain('"engine-result"');
      const texts = (value: unknown): string[] => typeof value === 'string' ? [value]
        : value && typeof value === 'object' ? Object.values(value).flatMap(texts) : [];
      const decodedSession = session.split('\n').filter(Boolean).flatMap((line) => texts(JSON.parse(line))).join('\n');
      for (const secret of [...secretForms, 'not-a-live-fixture-credential']) {
        expect(decodedSession).not.toContain(secret);
      }
      if (fails) expect(retained).toContain(marker + '-copilot-diagnostic');
    }
    await assertGone(invocation);
    expect(fs.existsSync(debugDirectory)).toBe(true);
    expect(commandTrace.join('\n')).not.toContain(marker);
  }, 90_000);

  test.each([1, 2])('public diagnostics: capture startup preserves script execution with pidsLimit=%s', async pidsLimit => {
    const invocation = plan('script', `
from pathlib import Path
Path("/awf/out").write_text('{"passed":true}')
`);
    const debugDirectory = path.join(resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId);
    debugDirectories.add(debugDirectory);
    const executor = backend(['script'], true, value => ({
      ...value, config: { ...value.config, pidsLimit },
    }));
    await expect(executor.execute(invocation, new AbortController().signal))
      .resolves.toEqual({ outcome: 'success', result: '{"passed":true}' });
    const diagnostics = JSON.parse(fs.readFileSync(path.join(debugDirectory, 'diagnostics.json'), 'utf8'));
    expect(diagnostics.streams).toMatchObject({ stdout: 'unavailable', stderr: 'unavailable' });
    expect(diagnostics.streamCoverage.captureErrors).toMatchObject({ stdout: 'io-error', stderr: 'io-error' });
    await assertGone(invocation);
  });

  test('public diagnostics: oversized stream and large public files preserve existing budgets and canonical results', async () => {
    const largeSeed = path.join(directory, 'large-public-fixture');
    fs.mkdirSync(largeSeed, { mode: 0o755 });
    fs.writeFileSync(path.join(largeSeed, 'large-fixture.bin'), Buffer.alloc(2 * MiB), { mode: 0o444 });
    const invocation = { ...plan('script', `
import os
from pathlib import Path
assert Path("/awf/seed/large-fixture.bin").stat().st_size == ${2 * MiB}
assert Path("/query/repo/large-fixture.bin").stat().st_size == ${2 * MiB}
assert Path("/query/budget-regression.bin").write_bytes(b"x" * ${2 * MiB}) == ${2 * MiB}
assert os.write(1, b"x" * ${PUBLIC_ENCLAVE_CAPTURE_BYTES + 4096}) == ${PUBLIC_ENCLAVE_CAPTURE_BYTES + 4096}
Path("/awf/out").write_text('{"passed":true}')
`), seedHostPath: largeSeed };
    const debugDirectory = path.join(resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId);
    debugDirectories.add(debugDirectory);
    expect(await backend(['script'], true).execute(invocation, new AbortController().signal))
      .toEqual({ outcome: 'success', result: '{"passed":true}' });
    const diagnostics = JSON.parse(fs.readFileSync(path.join(debugDirectory, 'diagnostics.json'), 'utf8'));
    expect(diagnostics.streams.stdout).toBe('oversized');
    expect(fs.statSync(path.join(debugDirectory, 'stdout.log')).size).toBe(0);
    expect(diagnostics).not.toHaveProperty('primaryFailure');
    expect(diagnostics).not.toHaveProperty('cleanupFailure');
    await assertGone(invocation);
  }, 90_000);

  test('public diagnostics: genuine Docker setup failure retains explicit unavailable evidence and cleans source storage', async () => {
    const invocation = plan('agent', 'raise AssertionError("PUBLIC-SETUP-WORKLOAD-MUST-NOT-START")');
    const debugDirectory = path.join(resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId);
    debugDirectories.add(debugDirectory);
    const executor = backend(['agent'], true, (value) => ({
      ...value, config: { ...value.config, network: `awf-missing-${randomBytes(8).toString('hex')}` },
    }));
    const result = await executor.execute(invocation, new AbortController().signal);
    expect(result).toEqual({ outcome: 'executor-failure' });
    const diagnostics = JSON.parse(fs.readFileSync(path.join(debugDirectory, 'diagnostics.json'), 'utf8'));
    expect(diagnostics).toMatchObject({
      version: 1, runtime: 'docker', runId, invocationId: invocation.invocationId, executorKind: 'agent',
      stage: 'setup', failure: 'setup-failed', exitCode: null, workloadStopped: true,
      workloadLaunched: false, stopProof: 'not-launched',
    });
    expect(diagnostics.backendEvidence.dockerInspect.status).toBe('unavailable');
    expect(diagnostics.backendEvidence.vmCounters.status).toBe('not-applicable');
    expect(diagnostics.backendEvidence.network.status).toBe('unavailable');
    expect(diagnostics.primaryFailure).toMatchObject({ stage: 'network-isolation', category: 'host-exception' });
    expect(diagnostics.stages).toContainEqual(expect.objectContaining({
      stage: 'network-isolation', status: 'failed', category: 'host-exception',
    }));
    expect(diagnostics).not.toHaveProperty('cleanupFailure');
    const retained = PUBLIC_ENCLAVE_ARTIFACT_NAMES
      .map((name) => fs.readFileSync(path.join(debugDirectory, name), 'utf8')).join('\n');
    expect(retained).not.toContain('PUBLIC-SETUP-WORKLOAD-MUST-NOT-START');
    await assertGone(invocation);
  }, 90_000);

  test('public diagnostics: genuine missing-image setup failure proves absence before retaining evidence and cleaning storage', async () => {
    const missingImage = `awf-enclave-script:missing-${randomBytes(8).toString('hex')}`;
    const invocation = plan('script', 'raise AssertionError("MISSING-IMAGE-WORKLOAD-MUST-NOT-START")');
    const debugDirectory = path.join(resolveDockerPublicEnclaveDebugPaths().root, runId, invocation.invocationId);
    debugDirectories.add(debugDirectory);
    const executor = backend(['script'], true, (value) => ({
      ...value, config: { ...value.config, queryImage: missingImage },
    }));
    expect(await executor.execute(invocation, new AbortController().signal)).toEqual({ outcome: 'executor-failure' });
    const diagnostics = JSON.parse(fs.readFileSync(path.join(debugDirectory, 'diagnostics.json'), 'utf8'));
    expect(diagnostics).toMatchObject({
      runtime: 'docker', runId, invocationId: invocation.invocationId, executorKind: 'script',
      stage: 'setup', failure: 'setup-failed', exitCode: null,
      workloadLaunched: false, stopProof: 'not-launched',
      primaryFailure: { stage: 'storage-probe', category: 'not-found', errno: 2 },
      streams: { stdout: 'missing', stderr: 'missing', session: 'not-applicable' },
    });
    expect(diagnostics).not.toHaveProperty('cleanupFailure');
    expect(diagnostics.backendEvidence.dockerInspect.status).toBe('unavailable');
    expect(PUBLIC_ENCLAVE_ARTIFACT_NAMES.map((name) =>
      fs.readFileSync(path.join(debugDirectory, name), 'utf8')).join('\n'))
      .not.toContain('MISSING-IMAGE-WORKLOAD-MUST-NOT-START');
    expect(commandTrace.some((trace) => trace.includes(`No such image: ${missingImage}`))).toBe(true);
    await assertGone(invocation);
  }, 90_000);

  test('public diagnostics: persistent host artifacts reject primary mount exposure even with retention disabled', () => {
    const config: WrapperConfig = {
      workDir: path.join(directory, 'mount-policy'), allowedDomains: [], agentCommand: 'true',
      logLevel: 'error', keepContainers: false, enclaveDebugPublic: false,
    };
    const { protectedRoot } = resolveDockerPublicEnclaveDebugPaths();
    expect(() => assertPersistentDebugArtifactsIsolated({
      ...config, volumeMounts: [`${protectedRoot}:/exposed:ro`],
    })).toThrow(/persistent debug artifact root/);
    const alias = path.join(directory, 'debug-root-alias');
    fs.symlinkSync(protectedRoot, alias);
    try {
      expect(() => assertPersistentDebugArtifactsIsolated({
        ...config, volumeMounts: [`${alias}:/exposed:ro`],
      })).toThrow(/persistent debug artifact root/);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  test('coordinated private staging, scoped GitHub fixture tools, bounded agent result and complete cleanup', async () => {
      const stagingRoot = path.join(directory, 'scoped-staging');
      const stagingPaths = { root: stagingRoot, seedsDir: path.join(stagingRoot, 'seeds') };
      fs.mkdirSync(stagingRoot, { mode: 0o700 });
      const stagingCredential = 'synthetic-staging-credential-not-a-live-token';
      const identity = 'fixture-github-agent-identity-00000001';
      const gatewayName = `awf-fixture-mcpg-${randomBytes(4).toString('hex')}`;
      let gatewayId: string | undefined;
      const gitRunner: GitRunner = async (args, { env }) => {
        expect(args.join(' ')).not.toContain(stagingCredential);
        expect(Object.values(env).join(' ')).not.toContain(stagingCredential);
        if (args.includes('clone')) {
          const destination = args[args.length - 1];
          fs.mkdirSync(path.join(destination, '.git', 'hooks'), { recursive: true });
          fs.writeFileSync(path.join(destination, '.git', 'config'),
            `[remote "origin"]\nurl=https://x-access-token:${stagingCredential}@github.com/fixture/private.git\n`);
          fs.writeFileSync(path.join(destination, '.git', 'hooks', 'post-checkout'), 'untrusted hook');
          fs.writeFileSync(path.join(destination, 'private.txt'), sentinel);
        }
        return { stdout: args[0] === 'rev-parse' ? '1'.repeat(40) : '' };
      };
      const responder = `
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args): pass
      def do_POST(self):
          body=json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
          code=200
          if self.path!="/mcp/github" or self.headers.get("Authorization")!=${JSON.stringify(identity)}:
              code=401; result={}
          elif body.get("method")=="tools/list":
              result={"tools":[{"name":"list_issues"},{"name":"issue_read"}]}
          elif body.get("method")=="tools/call":
              p=body.get("params", {}); a=p.get("arguments", {})
              if p.get("name") not in ("list_issues","issue_read") or a.get("owner")!="fixture" or a.get("repo")!="private":
                  code=403; result={}
              else: result={"content":[{"type":"text","text":"controlled issue metadata"}]}
          else: code=400; result={}
          payload=json.dumps({"jsonrpc":"2.0","id":body.get("id"),"result":result}).encode()
          self.send_response(code); self.send_header("Content-Type","application/json")
          self.send_header("Content-Length",str(len(payload))); self.end_headers(); self.wfile.write(payload)
HTTPServer(("0.0.0.0",8082),Handler).serve_forever()
`;
      try {
        const staged = await stageEnclaveSeeds({
          repos: [{ repo: 'fixture/private', sensitivity: 'internal' }], paths: stagingPaths,
          runId, token: stagingCredential, gitRunner,
        });
        const stagedSeed = path.join(stagingPaths.seedsDir, staged.seeds[0].seedId);
        expect(fs.statSync(stagedSeed).mode & 0o777).toBe(0o555);
        expect(fs.existsSync(path.join(stagedSeed, '.git', 'hooks'))).toBe(false);
        expect(fs.readFileSync(path.join(stagedSeed, '.git', 'config'), 'utf8')).not.toContain(stagingCredential);
        expect(fs.readdirSync(stagingRoot)).toEqual(['seeds']);
        gatewayId = await docker([
          'run', '-d', '--name', gatewayName, '--network', network, '--ip', '172.31.0.40',
          '--network-alias', 'awf-enclave-github-mcp', '--user', '65534:65534', '--cap-drop', 'ALL',
          '--security-opt', 'no-new-privileges:true', '--read-only', '--memory', '64m', '--pids-limit', '32',
          '--entrypoint', '/usr/bin/python3', image, '-I', '-u', '-c', responder,
        ]);
        await until(async () => {
          try {
            await docker(['exec', gatewayId!, '/usr/bin/python3', '-c',
              'import socket; socket.create_connection(("127.0.0.1",8082),timeout=1).close()']);
            return true;
          } catch { return undefined; }
        }, 'controlled scoped GitHub responder');
        const scopedEntry = entry('agent');
        scopedEntry.config = {
          ...scopedEntry.config, githubEnabled: true, githubProfile: 'issues-read-v1',
          githubMcpUrl: 'http://172.31.0.40:8082/mcp/github', githubGatewayContainer: gatewayName,
          enclaveGithubAgentIdPath: '/run/awf-enclave-github/agent-id',
        };
        const executor = createDockerHostEnclaveExecutor({
          ...options(), entries: [scopedEntry],
          resolveAgentAuthority: async () => ({ githubAgentId: identity, repository: 'fixture/private' }),
        });
        backends.push(executor);
        const invocation = {
          ...plan('agent', `
import json, os, urllib.error, urllib.request
from pathlib import Path
assert os.geteuid()==65534
assert Path("/awf/seed/private.txt").read_text()==${JSON.stringify(sentinel)}
assert ${JSON.stringify(stagingCredential)} not in json.dumps(dict(os.environ))
cfg=json.loads(Path("/agent/github-mcp.json").read_text())["mcpServers"]["github"]
assert cfg["url"]=="http://172.31.0.40:8082/mcp/github"
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def rpc(method, params=None):
      request=urllib.request.Request(cfg["url"],data=json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or {}}).encode(),
          headers={**cfg["headers"],"Content-Type":"application/json"})
      return json.loads(opener.open(request,timeout=5).read())["result"]
assert [t["name"] for t in rpc("tools/list")["tools"]]==["list_issues","issue_read"]
for tool in ["list_issues","issue_read"]:
      assert rpc("tools/call",{"name":tool,"arguments":{"owner":"fixture","repo":"private"}})["content"]
for tool, repo in [("create_issue","private"),("list_issues","other")]:
      try:
          rpc("tools/call",{"name":tool,"arguments":{"owner":"fixture","repo":repo}})
          raise AssertionError("out-of-scope tool accepted")
      except urllib.error.HTTPError as error: assert error.code==403
Path("/awf/out").write_text('{"passed":true}')
`),
          seedId: staged.seeds[0].seedId, seedHostPath: stagedSeed,
        };
        await executor.prepare();
        const result = await executor.execute(invocation, new AbortController().signal);
        expect(result).toEqual({ outcome: 'success', result: '{"passed":true}' });
        expect(Buffer.byteLength(result.result!)).toBeLessThan(2048);
        expect(JSON.stringify(result)).not.toContain(sentinel);
        expect(JSON.stringify(result)).not.toContain(stagingCredential);
        await assertGone(invocation);
        await executor.close();
      } finally {
        if (gatewayId) await docker(['rm', '-f', gatewayId]);
        releaseSeedPermissions(stagingPaths.seedsDir);
        fs.rmSync(stagingRoot, { recursive: true, force: true });
      }
  }, 90_000);

  test('independent concurrent runs retain distinct allocations and journals through cleanup', async () => {
    const runs = [randomBytes(16).toString('hex'), randomBytes(16).toString('hex')];
    const journals = runs.map((run) => path.join(directory, `journal-${run}`));
    const invocations = runs.map((run) => ({
      ...plan('script', confinement + `
Path("/awf/out").write_text('{"passed":true}')
time.sleep(3)
`),
      runId: run,
    }));
    const executors = runs.map((run, index) => {
      const executor = createDockerHostEnclaveExecutor({
        ...options(), runId: run, journalDir: journals[index], entries: [entry('script')],
      });
      backends.push(executor);
      return executor;
    });
    const pending = executors.map((executor, index) =>
      executor.execute(invocations[index], new AbortController().signal));
    await Promise.all(invocations.map(running));
    const allocations = invocations.map(storagePath);
    expect(allocations[0]).not.toBe(allocations[1]);
    expect(fs.statSync(allocations[0]).dev).not.toBe(fs.statSync(allocations[1]).dev);
    for (let index = 0; index < runs.length; index++) {
      expect(fs.readdirSync(journals[index])).toHaveLength(1);
      expect(fs.readdirSync(journals[index])[0]).toContain(runs[index]);
    }
    expect(await Promise.all(pending)).toEqual([
      { outcome: 'success', result: '{"passed":true}' },
      { outcome: 'success', result: '{"passed":true}' },
    ]);
    for (let index = 0; index < runs.length; index++) {
      await assertGone(invocations[index]);
      expect(fs.readdirSync(journals[index])).toEqual([]);
      await executors[index].close();
    }
  }, 90_000);

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
    const inspected = await running(invocation);
    await until(async () => await docker(['exec', '--user', '65534:65534', inspected.Id, 'cat', '/awf/out']) === sentinel
      || undefined, 'private output');
    controller.abort();
    const result = await pending;
    expect(result).toEqual({ outcome: 'cancelled' });
    expect(JSON.stringify(result)).not.toContain(sentinel);
    await assertGone(invocation);
  });

  test.each(['timeout', 'broker-loss', 'shutdown'] as const)(
    'host %s drains a real Docker workload before releasing private storage',
    async (reason) => {
      const invocation = plan('script', `
import time
from pathlib import Path
Path("/awf/out").write_text(${JSON.stringify(sentinel)})
time.sleep(120)
`);
      const hostInvocation = {
        ...invocation,
        invocationHostDir: path.join(directory, 'invocations', 'script', invocation.invocationId),
      };
      const server = await startHostExecutorServer({
        runtimeDir: path.join(directory, `ipc-${reason}`),
        statusLeaseMs: reason === 'broker-loss' ? 6_000 : 30_000,
        runState: {
          runId, seedsDir: path.dirname(seed), invocationsDir: path.join(directory, 'invocations'),
          journalDir: path.join(directory, `protocol-journal-${reason}`),
          entries: [{
            entryId: 'script', executorKind: 'script', timeoutMs: reason === 'timeout' ? 6_000 : 30_000,
            staticSeedIds: [seedId], dynamicAgents: false,
          }],
        },
        backend: backend(),
      });
      try {
        const { createHostExecutorClient } = require('../../containers/enclave/mcp-server/host-executor-client');
        const client = createHostExecutorClient({
          socketPath: server.socketPath, capabilityPath: server.capabilityPath, runId,
        });
        const wireSchema = serializeFiniteSchema(schema);
        expect(await client.invoke({
          entryId: 'script', invocationId: invocation.invocationId, executorKind: 'script',
          seedId, payload: invocation.payload, schema: wireSchema,
          schemaHash: finiteSchemaHash(wireSchema), admissionId: invocation.admissionId,
        })).toMatchObject({ ok: true, state: 'running' });
        const inspected = await running(hostInvocation);
        await until(async () => await docker(['exec', '--user', '65534:65534', inspected.Id, 'cat', '/awf/out']) === sentinel
          || undefined, 'private output before host interruption');
        if (reason === 'shutdown') await server.close();
        else {
          // No status polling: broker-loss must exercise actual lease expiry.
          await until(async () => !fs.existsSync(storagePath(hostInvocation)) || undefined, 'host-owned cleanup');
          const status = await until(async () => {
            const response = await client.status({ entryId: 'script', invocationId: invocation.invocationId });
            return response.state === 'terminal' ? response : undefined;
          }, 'terminal after verified cleanup');
          expect(status).toMatchObject({ ok: true, outcome: reason === 'timeout' ? 'timeout' : 'cancelled' });
          expect(status).not.toHaveProperty('result');
          expect(JSON.stringify(status)).not.toContain(sentinel);
          expect(await client.settle({
            entryId: 'script', invocationId: invocation.invocationId, resultDigest: status.resultDigest,
          })).toMatchObject({ ok: true, state: 'settled' });
        }
        await assertGone(hostInvocation);
      } finally {
        await server.close();
      }
      expect(fs.existsSync(server.socketPath)).toBe(false);
      expect(fs.existsSync(server.capabilityPath)).toBe(false);
    },
  );

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
    expect(result).toEqual({ outcome: 'executor-failure', recoverableFailure: true, cleanupComplete: true });
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

  privilegedAcceptance('a split mount namespace with the same source pathname fails closed before private workload launch', async () => {
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
