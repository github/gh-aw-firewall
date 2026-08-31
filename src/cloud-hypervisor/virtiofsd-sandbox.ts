import * as path from 'path';

const WORKER_READY_TIMEOUT_MS = 5_000;
const WORKER_READY_INTERVAL_MS = 50;
const REVIEWED_WORKER_CAPABILITIES = '00000000880000db';
const REVIEWED_WORKER_CAPABILITY_BITS = BigInt(`0x${REVIEWED_WORKER_CAPABILITIES}`);
const ZERO_CAPABILITIES = /^0+$/;
const CAPABILITY_MASK = /^[0-9a-f]{16}$/;
const REQUIRED_NAMESPACES = ['mnt', 'pid', 'net'] as const;
const CAPABILITY_FIELDS = ['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'] as const;
const CGROUP_ROOT = '/sys/fs/cgroup';

export const VIRTIOFSD_ENVIRONMENT = Object.freeze({
  PATH: '/usr/sbin:/usr/bin:/sbin:/bin',
  HOME: '/nonexistent',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});

export interface VirtiofsdProcessIdentity {
  readonly pid: number;
  readonly startTime: string;
  readonly executable: string;
  readonly commandLine: readonly string[];
}

export interface VirtiofsdSandboxDependencies {
  readFile(filePath: string, encoding: BufferEncoding): Promise<string>;
  readlink(filePath: string): Promise<string>;
  statIdentity(filePath: string): Promise<{ dev: number | bigint; ino: number | bigint }>;
  writeFile(filePath: string, contents: string, options: { mode: number }): Promise<void>;
  sleep(milliseconds: number): Promise<void>;
}

export interface VirtiofsdSandboxVerificationOptions {
  readonly exportTag: string;
  readonly parentIdentity: VirtiofsdProcessIdentity;
  readonly expectedExecutable: string;
  readonly socketPath: string;
  readonly sharedDirectory: string;
  readonly cgroupPath: string;
  readonly evidencePath: string;
  readonly assignToCgroup: (pid: number) => Promise<void>;
}

interface ProcessEvidence {
  pid: number;
  startTime: string;
  executable: string;
  uid: string;
  gid: string;
  capabilities: Record<string, string>;
  noNewPrivs: number;
  seccomp: number;
  environment: string[];
  environmentValuesMatch: boolean;
  cgroup: string;
}

/**
 * Captures the immutable process identity used to reject PID reuse between
 * spawn, readiness, sandbox verification, and cleanup.
 */
export async function captureVirtiofsdProcessIdentity(
  pid: number,
  dependencies: Pick<VirtiofsdSandboxDependencies, 'readFile' | 'readlink'>,
): Promise<VirtiofsdProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new Error(`virtiofsd exposed an invalid PID: ${pid}`);
  }
  const stat = await dependencies.readFile(`/proc/${pid}/stat`, 'utf8');
  const end = stat.lastIndexOf(')');
  if (end < 0) throw new Error(`virtiofsd PID ${pid} has malformed /proc stat data`);
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const startTime = fields[19];
  if (!startTime || !/^\d+$/.test(startTime)) {
    throw new Error(`virtiofsd PID ${pid} has no valid process start time`);
  }
  const executable = await dependencies.readlink(`/proc/${pid}/exe`);
  const commandLine = parseNullDelimited(
    await dependencies.readFile(`/proc/${pid}/cmdline`, 'utf8'),
  );
  return { pid, startTime, executable, commandLine };
}

/**
 * Verifies virtiofsd's namespace sandbox from host procfs and persists the
 * observations before the socket can be passed to Cloud Hypervisor.
 */
export async function verifyVirtiofsdSandbox(
  options: VirtiofsdSandboxVerificationOptions,
  dependencies: VirtiofsdSandboxDependencies,
): Promise<VirtiofsdProcessIdentity> {
  const evidence: Record<string, unknown> = {
    version: 1,
    verified: false,
    exportTag: options.exportTag,
    expectedExecutable: options.expectedExecutable,
    expectedCgroup: options.cgroupPath,
    expectedRoot: options.sharedDirectory,
    expectedEnvironment: Object.keys(VIRTIOFSD_ENVIRONMENT).sort(),
    parent: null,
    worker: null,
    namespaces: null,
    root: null,
  };
  let verificationError: unknown;
  let verifiedWorker: VirtiofsdProcessIdentity | undefined;

  try {
    const currentParent = await captureVirtiofsdProcessIdentity(
      options.parentIdentity.pid,
      dependencies,
    );
    assertSameIdentity(options.parentIdentity, currentParent, 'parent');
    assertLaunchCommand(currentParent, options);

    const workerPid = await waitForWorker(options.parentIdentity.pid, dependencies);
    const workerIdentity = await captureVirtiofsdProcessIdentity(workerPid, dependencies);
    assertExecutable(workerIdentity.executable, options.expectedExecutable, 'worker');
    await options.assignToCgroup(workerPid);
    const currentWorker = await captureVirtiofsdProcessIdentity(workerPid, dependencies);
    assertSameIdentity(workerIdentity, currentWorker, 'worker');

    const parent = await collectProcessEvidence(currentParent, options.cgroupPath, dependencies);
    const worker = await collectProcessEvidence(currentWorker, options.cgroupPath, dependencies);
    evidence.parent = parent;
    evidence.worker = worker;

    assertRootIdentity(parent, 'parent');
    assertRootIdentity(worker, 'worker');
    for (const field of CAPABILITY_FIELDS) {
      if (!ZERO_CAPABILITIES.test(parent.capabilities[field] ?? '')) {
        throw new Error(`virtiofsd parent ${field} is not empty`);
      }
    }
    if (
      worker.capabilities.CapEff !== REVIEWED_WORKER_CAPABILITIES ||
      worker.capabilities.CapPrm !== REVIEWED_WORKER_CAPABILITIES ||
      !ZERO_CAPABILITIES.test(worker.capabilities.CapInh ?? '') ||
      !ZERO_CAPABILITIES.test(worker.capabilities.CapAmb ?? '')
    ) {
      throw new Error('virtiofsd worker capabilities differ from the reviewed sandbox set');
    }
    const workerBounding = worker.capabilities.CapBnd ?? '';
    if (
      !CAPABILITY_MASK.test(workerBounding) ||
      (BigInt(`0x${workerBounding}`) & REVIEWED_WORKER_CAPABILITY_BITS) !==
        REVIEWED_WORKER_CAPABILITY_BITS
    ) {
      throw new Error('virtiofsd worker bounding set excludes reviewed runtime capabilities');
    }
    if (worker.noNewPrivs !== 1 || worker.seccomp !== 2) {
      throw new Error('virtiofsd worker is missing NoNewPrivs or seccomp filtering');
    }
    const expectedEnvironment = Object.keys(VIRTIOFSD_ENVIRONMENT).sort();
    for (const [role, processEvidence] of [['parent', parent], ['worker', worker]] as const) {
      if (
        !arraysEqual(processEvidence.environment, expectedEnvironment) ||
        !processEvidence.environmentValuesMatch
      ) {
        throw new Error(
          `virtiofsd ${role} inherited unexpected environment variables: ` +
          processEvidence.environment.join(', '),
        );
      }
      assertCgroup(processEvidence.cgroup, options.cgroupPath, role);
    }

    const namespaces: Record<string, { host: string; worker: string }> = {};
    for (const name of REQUIRED_NAMESPACES) {
      const host = await dependencies.readlink(`/proc/self/ns/${name}`);
      const sandbox = await dependencies.readlink(`/proc/${workerPid}/ns/${name}`);
      if (host === sandbox) {
        throw new Error(`virtiofsd worker did not isolate its ${name} namespace`);
      }
      namespaces[name] = { host, worker: sandbox };
    }
    evidence.namespaces = namespaces;

    const actualRoot = await inodeIdentity(`/proc/${workerPid}/root`, dependencies);
    const expectedRoot = await inodeIdentity(options.sharedDirectory, dependencies);
    evidence.root = { actual: actualRoot, expected: expectedRoot };
    if (actualRoot !== expectedRoot) {
      throw new Error('virtiofsd worker root is not its declared export');
    }

    assertSameIdentity(
      options.parentIdentity,
      await captureVirtiofsdProcessIdentity(options.parentIdentity.pid, dependencies),
      'parent',
    );
    assertSameIdentity(
      workerIdentity,
      await captureVirtiofsdProcessIdentity(workerPid, dependencies),
      'worker',
    );
    verifiedWorker = workerIdentity;
    evidence.verified = true;
  } catch (error) {
    verificationError = error;
    evidence.error = formatError(error);
  }

  try {
    await dependencies.writeFile(
      options.evidencePath,
      `${JSON.stringify(evidence, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    if (verificationError !== undefined) {
      throw new Error(
        `virtiofsd sandbox verification failed: ${formatError(verificationError)}; ` +
        `writing confinement evidence failed: ${formatError(error)}`,
      );
    }
    throw new Error(`writing virtiofsd confinement evidence failed: ${formatError(error)}`);
  }
  if (verificationError !== undefined) {
    throw new Error(`virtiofsd sandbox verification failed: ${formatError(verificationError)}`);
  }
  if (!verifiedWorker) throw new Error('virtiofsd sandbox verification produced no worker identity');
  return verifiedWorker;
}

async function waitForWorker(
  parentPid: number,
  dependencies: VirtiofsdSandboxDependencies,
): Promise<number> {
  const deadline = Date.now() + WORKER_READY_TIMEOUT_MS;
  do {
    const children = (
      await dependencies.readFile(`/proc/${parentPid}/task/${parentPid}/children`, 'utf8')
    ).trim().split(/\s+/).filter(Boolean);
    for (const value of children) {
      const candidate = Number(value);
      if (!Number.isSafeInteger(candidate) || candidate <= 1) continue;
      try {
        const comm = await dependencies.readFile(`/proc/${candidate}/comm`, 'utf8');
        if (comm.trim() === 'virtiofsd') return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await dependencies.sleep(WORKER_READY_INTERVAL_MS);
  } while (Date.now() < deadline);
  throw new Error('virtiofsd did not create its sandbox worker');
}

async function collectProcessEvidence(
  identity: VirtiofsdProcessIdentity,
  cgroupPath: string,
  dependencies: VirtiofsdSandboxDependencies,
): Promise<ProcessEvidence> {
  const status = parseStatus(await dependencies.readFile(`/proc/${identity.pid}/status`, 'utf8'));
  const capabilities = Object.fromEntries(
    CAPABILITY_FIELDS.map((field) => [field, status[field] ?? '']),
  );
  const environmentEntries = parseNullDelimited(
    await dependencies.readFile(`/proc/${identity.pid}/environ`, 'utf8'),
  ).sort();
  const expectedEnvironmentEntries = Object.entries(VIRTIOFSD_ENVIRONMENT)
    .map(([name, value]) => `${name}=${value}`)
    .sort();
  return {
    pid: identity.pid,
    startTime: identity.startTime,
    executable: identity.executable,
    uid: status.Uid ?? '',
    gid: status.Gid ?? '',
    capabilities,
    noNewPrivs: Number(status.NoNewPrivs),
    seccomp: Number(status.Seccomp),
    environment: environmentEntries.map(environmentName).sort(),
    environmentValuesMatch: arraysEqual(environmentEntries, expectedEnvironmentEntries),
    cgroup: (await dependencies.readFile(`/proc/${identity.pid}/cgroup`, 'utf8')).trim(),
  };
}

function assertRootIdentity(evidence: ProcessEvidence, role: string): void {
  if (evidence.uid !== '0\t0\t0\t0' || evidence.gid !== '0\t0\t0\t0') {
    throw new Error(
      `virtiofsd ${role} uid/gid differs from the reviewed namespace-sandbox identity`,
    );
  }
}

function assertCgroup(actual: string, expectedPath: string, role: string): void {
  const relative = path.relative(CGROUP_ROOT, expectedPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`virtiofsd expected cgroup is outside cgroup v2: ${expectedPath}`);
  }
  const expected = `0::/${relative}`;
  if (actual.split(/\r?\n/).filter(Boolean).length !== 1 || actual !== expected) {
    throw new Error(`virtiofsd ${role} is not in its expected cgroup`);
  }
}

function assertSameIdentity(
  expected: VirtiofsdProcessIdentity,
  actual: VirtiofsdProcessIdentity,
  role: string,
): void {
  if (
    expected.pid !== actual.pid ||
    expected.startTime !== actual.startTime ||
    expected.executable !== actual.executable
  ) {
    throw new Error(`virtiofsd ${role} process identity changed before sandbox verification`);
  }
}

function assertExecutable(actual: string, expected: string, role: string): void {
  if (actual !== expected) {
    throw new Error(`virtiofsd ${role} executable differs from the trusted binary`);
  }
}

function assertLaunchCommand(
  identity: VirtiofsdProcessIdentity,
  options: VirtiofsdSandboxVerificationOptions,
): void {
  assertExecutable(identity.executable, options.expectedExecutable, 'parent');
  const command = identity.commandLine;
  if (
    !command.includes(`--socket-path=${options.socketPath}`) ||
    !command.includes(`--shared-dir=${options.sharedDirectory}`) ||
    !command.includes('--sandbox=namespace') ||
    !command.includes('--seccomp=kill')
  ) {
    throw new Error('virtiofsd parent command line does not match the requested sandbox export');
  }
}

function parseStatus(contents: string): Record<string, string> {
  const entries = contents.split(/\r?\n/).map((line) => /^([^:]+):\s*(.*)$/.exec(line));
  return Object.fromEntries(
    entries.filter((entry): entry is RegExpExecArray => entry !== null)
      .map((entry) => [entry[1], entry[2]]),
  );
}

function parseNullDelimited(contents: string): string[] {
  return contents.split('\0').filter(Boolean);
}

function environmentName(entry: string): string {
  const separator = entry.indexOf('=');
  return separator < 0 ? entry : entry.slice(0, separator);
}

async function inodeIdentity(
  filePath: string,
  dependencies: Pick<VirtiofsdSandboxDependencies, 'statIdentity'>,
): Promise<string> {
  const stat = await dependencies.statIdentity(filePath);
  return `${stat.dev}:${stat.ino}`;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
