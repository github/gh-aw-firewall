import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateDockerCompose } from '../../src/compose-generator';
import { resolveCloudHypervisorExports } from '../../src/cloud-hypervisor/exports';
import { resolveNvxExports } from '../../src/nvx/workspace-export';
import { credentialFilesToHide } from '../../src/config/mount-policy';
import { normalizeEnclavesConfig } from '../../src/parsers/enclave-parser';
import { dockerSensitiveTmpfs } from '../../src/sensitive-paths';
import { ensureNestedMountpoints } from '../../src/services/agent-volumes/nested-mountpoints';
import type { WrapperConfig } from '../../src/types';

const document = path.resolve(__dirname, '../../docs/filesystem-sharing-contract.md');
const start = '<!-- sharing-plan:start -->';
const end = '<!-- sharing-plan:end -->';

export interface SharingRow {
  scenario: string;
  source: string;
  consumer: string;
  destination: string;
  access: string;
  mechanism: string;
  provenance?: string;
}

function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

export function parseTmpfsEntry(entry: string): {
  target: string;
  options: string;
  access: string;
} {
  const separator = entry.indexOf(':');
  const target = separator < 0 ? entry : entry.slice(0, separator);
  const options = separator < 0 ? '' : entry.slice(separator + 1);
  const readOnly = options.split(',').includes('ro');
  return {
    target,
    options,
    access: `${readOnly ? 'ro' : 'rw'} (tmpfs${options ? `; ${options}` : ''})`,
  };
}

function composeRows(
  config: WrapperConfig,
  scenario: string,
  fixtureRoot: string,
  hostTmp: string,
): SharingRow[] {
  const sensitiveTmpfsTargets = new Set(
    dockerSensitiveTmpfs(config.workDir).map((entry) => entry.split(':', 1)[0]),
  );
  const fixturePathExists = (candidate: string): boolean => {
    if (candidate === '/etc/pki/ca-trust/extracted') {
      return fs.existsSync(path.join(fixtureRoot, 'etc/pki/ca-trust/extracted'));
    }
    if (candidate === '/etc/pki/tls/certs') {
      return fs.existsSync(path.join(fixtureRoot, 'etc/pki/tls/certs'));
    }
    return fs.existsSync(candidate);
  };
  const compose = generateDockerCompose(config, {
    subnet: '172.30.0.0/24', squidIp: '172.30.0.10',
    agentIp: '172.30.0.20', proxyIp: '172.30.0.30',
  }, undefined, undefined, {
    effectiveHome: path.join(fixtureRoot, 'home'),
    pathExists: fixturePathExists,
    prepareNestedMountpoints: (volumes, uid, gid, _resolver) => {
      const prepared = ensureNestedMountpoints(volumes, uid, gid, (source) => {
        if (source === '/tmp') return hostTmp;
        if (source === '/dev/null' || isPathWithin(fixtureRoot, source)) return source;
        return undefined;
      });
      if (prepared.some((candidate) =>
        !isPathWithin(fixtureRoot, candidate) && !isPathWithin(hostTmp, candidate))) {
        throw new Error('Sharing inventory attempted mountpoint preparation outside its fixture');
      }
      return prepared;
    },
  });
  return Object.entries(compose.services).flatMap(([consumer, service]) => [
    ...(service.volumes || []).map((volume: string) => {
      const parts = volume.split(':');
      if (parts.length < 2 || parts.length > 3) {
        throw new Error(`Unexpected Compose volume shape in ${consumer}`);
      }
      return {
        scenario, source: parts[0], consumer, destination: parts[1],
        access: parts[2] || 'rw (Compose default)', mechanism: 'Compose bind/volume',
      };
    }),
    ...(service.tmpfs || []).map((entry: string) => {
      const tmpfs = parseTmpfsEntry(entry);
      return {
        scenario, source: 'ephemeral tmpfs', consumer, destination: tmpfs.target,
        access: tmpfs.access,
        mechanism: 'Compose tmpfs',
        ...(consumer === 'agent' && sensitiveTmpfsTargets.has(tmpfs.target)
          ? { provenance: 'sensitive-path mask' }
          : {}),
      };
    }),
  ]);
}

export async function collectSharingRows(): Promise<SharingRow[]> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sharing-')));
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  const previousHome = process.env.HOME;
  const previousSudoUser = process.env.SUDO_USER;
  const previousToolCache = process.env.RUNNER_TOOL_CACHE;
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  try {
    const fixtureRoot = path.join(root, 'fixture');
    const tools = path.join(fixtureRoot, 'tools');
    const home = path.join(fixtureRoot, 'home');
    const sharedTmp = path.join(fixtureRoot, 'shared-tmp-gh-aw');
    const runnerTemp = path.join(fixtureRoot, 'runner-temp');
    const fixtureWorkspace = path.join(fixtureRoot, 'workspace');
    fs.mkdirSync(fixtureRoot);
    fs.mkdirSync(fixtureWorkspace);
    fs.mkdirSync(tools);
    fs.mkdirSync(home);
    fs.mkdirSync(path.join(home, '.copilot'));
    fs.mkdirSync(sharedTmp);
    fs.mkdirSync(path.join(runnerTemp, 'gh-aw'), { recursive: true });
    const hostTmp = path.join(root, 'host-tmp');
    fs.mkdirSync(hostTmp);
    fs.mkdirSync(path.join(fixtureRoot, 'etc/pki/ca-trust/extracted'), { recursive: true });
    for (const credential of credentialFilesToHide()) {
      const filename = path.join(home, credential);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, '');
    }
    process.env.GITHUB_WORKSPACE = fixtureWorkspace;
    process.env.HOME = home;
    process.env.RUNNER_TOOL_CACHE = tools;
    process.env.RUNNER_TEMP = runnerTemp;
    delete process.env.SUDO_USER;
    const base: WrapperConfig = {
      allowedDomains: [], agentCommand: 'echo test', logLevel: 'error',
      keepContainers: false, workDir: path.join(fixtureRoot, 'work'),
      buildLocal: false,
    };
    fs.mkdirSync(base.workDir);
    fs.mkdirSync(path.join(hostTmp, path.basename(root)));
    fs.cpSync(fixtureRoot, path.join(hostTmp, path.basename(root), 'fixture'), { recursive: true });
    const scenarios: Array<[string, Partial<WrapperConfig>]> = [
      ['compose/default', {}],
      ['compose/api-proxy', { enableApiProxy: true }],
      ['compose/allowWrite-empty', { filesystemAllowWrite: [] }],
      ['compose/enclaves-enabled', {
        enclaves: normalizeEnclavesConfig([{
          script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }],
        }]),
      }],
    ];
    const rows = scenarios.flatMap(([name, overrides]) =>
      composeRows({ ...base, ...overrides }, name, fixtureRoot, hostTmp));
    for (const runtime of ['cloud-hypervisor', 'nvx'] as const) {
      for (const policy of ['workspace-only', 'workspace-and-tool-cache'] as const) {
        const environment = {
          GITHUB_WORKSPACE: fixtureWorkspace, RUNNER_TOOL_CACHE: tools, RUNNER_TEMP: runnerTemp,
        };
        const exports = runtime === 'cloud-hypervisor'
          ? await resolveCloudHypervisorExports(environment, fixtureWorkspace, policy, sharedTmp)
          : await resolveNvxExports(environment, fixtureWorkspace, policy);
        rows.push(...exports.map(entry => ({
          scenario: `${runtime}/${policy}`, source: entry.source,
          consumer: 'primary agent', destination: entry.target,
          access: entry.mode, mechanism: 'virtio-fs export (write narrowing separate)',
        })));
      }
    }
    const replacements: Array<[string, string]> = [
      [home, '<HOME>'], [sharedTmp, '/tmp/gh-aw'],
      [fixtureRoot, '<FIXTURE>'], [runnerTemp, '<FIXTURE>/runner-temp'],
      [path.resolve(__dirname, '../..'), '<REPO>'],
    ];
    return rows.map(row => {
      const replace = (value: string): string => replacements.reduce(
        (result, [from, to]) => result.split(from).join(to), value,
      );
      return {
        ...row,
        source: replace(row.source)
          .replace(/\/chroot-[^/]+\/hosts$/, '/chroot-<ID>/hosts')
          .replace(/awf-enclave-private-[^/]+/g, 'awf-enclave-private-<ID>')
          .replace(/awf-enclave-control-[^/]+/g, 'awf-enclave-control-<ID>'),
        destination: replace(row.destination),
      };
    });
  } finally {
    if (previousWorkspace === undefined) delete process.env.GITHUB_WORKSPACE;
    else process.env.GITHUB_WORKSPACE = previousWorkspace;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSudoUser === undefined) delete process.env.SUDO_USER;
    else process.env.SUDO_USER = previousSudoUser;
    if (previousToolCache === undefined) delete process.env.RUNNER_TOOL_CACHE;
    else process.env.RUNNER_TOOL_CACHE = previousToolCache;
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderSharingRows(rows: readonly SharingRow[]): string {
  const cell = (value: string) => value.replace(/\\/g, '\\\\').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const hostRule = (row: SharingRow): [string, string] => {
    if (row.source === 'ephemeral tmpfs') return ['container-created; mode per tmpfs options', 'container lifetime'];
    if (row.source === '<FIXTURE>/work' ||
      row.source.startsWith('<FIXTURE>/work/') ||
      row.source.startsWith('<FIXTURE>/work-') ||
      /^\/var\/tmp\/awf-enclave-(?:private|control)-/.test(row.source)) {
      return ['AWF setup; see lifecycle table', 'per-run cleanup / optional preservation'];
    }
    if (!row.source.startsWith('/') && !row.source.startsWith('<')) {
      return ['Docker-managed; see lifecycle table', 'Compose down -v'];
    }
    return ['existing DAC/modes preserved', 'host-owned / not removed'];
  };
  const purpose = (row: SharingRow): string => {
    if (row.consumer === 'enclave-mcp-server' && row.destination === '/run/awf-enclave-host-executor') {
      return 'authenticated host-executor channel; ro bind does not prevent socket calls';
    }
    if (row.consumer === 'enclave-mcp-server' && row.destination === '/srv/awf/seed-map.json') {
      return 'repository ledger metadata; no seed content';
    }
    if (row.provenance === 'sensitive-path mask') return 'sensitive-path confidentiality mask';
    if (row.source === '/dev/null') return 'credential/socket mask or virtual device';
    if (row.destination === '/host/dev/shm') return 'isolated shared-memory tmpfs';
    if (row.destination.includes('logs') || row.destination.includes('session-state')) return 'logs / state channel';
    if (row.destination.includes('init')) return 'init handshake channel';
    if (row.destination.includes('workspace')) return 'workload workspace';
    if (row.consumer === 'squid-proxy') return 'proxy configuration / logs';
    return 'component runtime input / tool state';
  };
  return [
    '| Runtime / activation | Source | Component / destination (identity above) | Owner / mode | Mount/export access | Lifecycle | Purpose / implementation |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(row => {
      const [owner, lifecycle] = hostRule(row);
      return `| ${[
        row.scenario, row.source, `${row.consumer} → ${row.destination}`,
        owner, row.access, lifecycle,
        `${purpose(row)}; ${row.mechanism}`,
      ].map(cell).join(' | ')} |`;
    }),
  ].join('\n');
}

export async function updateContract(write: boolean): Promise<void> {
  const original = fs.readFileSync(document, 'utf8');
  const begin = original.indexOf(start);
  const finish = original.indexOf(end);
  if (begin < 0 || finish < begin || original.indexOf(start, begin + start.length) !== -1 ||
    original.indexOf(end, finish + end.length) !== -1) {
    throw new Error('Contract must contain exactly one ordered sharing-plan marker pair');
  }
  const generated = `${original.slice(0, begin + start.length)}\n${renderSharingRows(await collectSharingRows())}\n${original.slice(finish)}`;
  if (write) fs.writeFileSync(document, generated);
  else if (generated !== original) throw new Error('Sharing contract drift: run npm run sharing:write');
}

if (require.main === module) {
  updateContract(process.argv[2] === '--write').catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
