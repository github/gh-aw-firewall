import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateDockerCompose } from '../../src/compose-generator';
import { resolveCloudHypervisorExports } from '../../src/cloud-hypervisor/exports';
import { resolveNvxExports } from '../../src/nvx/workspace-export';
import { getRealUserHome } from '../../src/host-identity';
import { credentialFilesToHide } from '../../src/config/mount-policy';
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
}

function composeRows(config: WrapperConfig, scenario: string): SharingRow[] {
  const compose = generateDockerCompose(config, {
    subnet: '172.30.0.0/24', squidIp: '172.30.0.10',
    agentIp: '172.30.0.20', proxyIp: '172.30.0.30',
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
    ...(service.tmpfs || []).map((target: string) => ({
      scenario, source: 'ephemeral tmpfs', consumer, destination: target,
      access: 'rw (tmpfs)', mechanism: 'Compose tmpfs',
    })),
  ]);
}

export async function collectSharingRows(): Promise<SharingRow[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-sharing-'));
  const previousWorkspace = process.env.GITHUB_WORKSPACE;
  const previousHome = process.env.HOME;
  const previousSudoUser = process.env.SUDO_USER;
  try {
    const workspace = path.join(root, 'workspace');
    const tools = path.join(root, 'tools');
    const home = path.join(root, 'home');
    fs.mkdirSync(workspace);
    fs.mkdirSync(tools);
    fs.mkdirSync(home);
    for (const credential of credentialFilesToHide()) {
      const filename = path.join(home, credential);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      fs.writeFileSync(filename, '');
    }
    process.env.GITHUB_WORKSPACE = workspace;
    process.env.HOME = home;
    delete process.env.SUDO_USER;
    const base: WrapperConfig = {
      allowedDomains: [], agentCommand: 'echo test', logLevel: 'error',
      keepContainers: false, workDir: path.join(root, 'work'),
      buildLocal: false,
    };
    fs.mkdirSync(base.workDir);
    const scenarios: Array<[string, Partial<WrapperConfig>]> = [
      ['compose/default', {}],
      ['compose/api-proxy', { enableApiProxy: true }],
      ['compose/allowWrite-empty', { filesystemAllowWrite: [] }],
    ];
    const rows = scenarios.flatMap(([name, overrides]) => composeRows({ ...base, ...overrides }, name));
    for (const [runtime, resolve] of [
      ['cloud-hypervisor', resolveCloudHypervisorExports],
      ['nvx', resolveNvxExports],
    ] as const) {
      for (const policy of ['workspace-only', 'workspace-and-tool-cache'] as const) {
        const exports = await resolve(
          { GITHUB_WORKSPACE: workspace, RUNNER_TOOL_CACHE: tools }, workspace, policy,
        );
        rows.push(...exports.map(entry => ({
          scenario: `${runtime}/${policy}`, source: entry.source,
          consumer: 'primary agent', destination: entry.target,
          access: entry.mode, mechanism: 'virtio-fs export (write narrowing separate)',
        })));
      }
    }
    const replacements: Array<[string, string]> = [
      [getRealUserHome(), '<HOME>'], [root, '<FIXTURE>'],
      [path.resolve(__dirname, '../..'), '<REPO>'],
    ];
    return rows.map(row => {
      const replace = (value: string): string => replacements.reduce(
        (result, [from, to]) => result.split(from).join(to), value,
      );
      return {
        ...row,
        source: replace(row.source).replace(/\/chroot-[^/]+\/hosts$/, '/chroot-<ID>/hosts'),
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
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function renderSharingRows(rows: readonly SharingRow[]): string {
  const cell = (value: string) => value.replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const hostRule = (row: SharingRow): [string, string] => {
    if (row.source === 'ephemeral tmpfs') return ['container-created; mode per tmpfs options', 'container lifetime'];
    if (row.source === '<FIXTURE>/work' ||
      row.source.startsWith('<FIXTURE>/work/') ||
      row.source.startsWith('<FIXTURE>/work-')) {
      return ['AWF setup; see lifecycle table', 'per-run cleanup / optional preservation'];
    }
    if (!row.source.startsWith('/') && !row.source.startsWith('<')) {
      return ['Docker-managed; see lifecycle table', 'Compose down -v'];
    }
    return ['existing DAC/modes preserved', 'host-owned / not removed'];
  };
  const purpose = (row: SharingRow): string => {
    if (row.source === '/dev/null') return 'credential/socket mask or virtual device';
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
