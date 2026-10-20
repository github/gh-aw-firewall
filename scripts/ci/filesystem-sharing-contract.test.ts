import {
  collectSharingRows,
  parseTmpfsEntry,
  renderSharingRows,
  updateContract,
} from './filesystem-sharing-contract';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function isWithin(parent: string, child: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.posix.sep}`) &&
    !path.posix.isAbsolute(relative));
}

describe('filesystem sharing contract', () => {
  it('matches final builder/export plans', async () => {
    await expect(updateContract(false)).resolves.toBeUndefined();
  });

  it('does not depend on a runner tool-cache environment value', async () => {
    const original = process.env.RUNNER_TOOL_CACHE;
    try {
      process.env.RUNNER_TOOL_CACHE = '/nonexistent-sharing-fixture-cache';
      const rows = await collectSharingRows();
      expect(rows.some(row => row.source === '/nonexistent-sharing-fixture-cache')).toBe(false);
      await expect(updateContract(false)).resolves.toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.RUNNER_TOOL_CACHE;
      else process.env.RUNNER_TOOL_CACHE = original;
    }
  });

  it('canonicalizes fixture paths when the temporary directory has a symlinked ancestor', async () => {
    const originalTmpDir = process.env.TMPDIR;
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sharing-root-'));
    const alias = path.join(temporary, 'alias');
    fs.symlinkSync(temporary, alias, 'dir');
    try {
      process.env.TMPDIR = alias;
      const rows = await collectSharingRows();
      expect(JSON.stringify(rows)).not.toContain(alias);
    } finally {
      if (originalTmpDir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpDir;
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  it('renders symbolic fixture paths as literal text rather than HTML', () => {
    expect(renderSharingRows([{
      scenario: 'test', source: '<HOME>', consumer: 'agent',
      destination: '/host<HOME>', access: 'ro', mechanism: 'bind',
    }])).toContain('&lt;HOME&gt;');
    expect(renderSharingRows([{
      scenario: 'test', source: '<FIXTURE>/workspace', consumer: 'agent',
      destination: '/workspace', access: 'rw', mechanism: 'export',
    }])).toContain('existing DAC/modes preserved');
  });

  it('keeps private roots out of every primary agent share and masks credentials', async () => {
    const rows = await collectSharingRows();
    const agent = rows.filter(row => row.consumer === 'agent' || row.consumer === 'primary agent');
    expect(agent.length).toBeGreaterThan(0);
    for (const row of agent) {
      expect(row.source).not.toMatch(/enclave-(?:private|control)|host-executor/);
      expect(row.destination).not.toMatch(/enclave-(?:private|control)|host-executor/);
      expect(row.source).not.toBe('<HOME>');
    }
    const standard = agent.filter(row => row.scenario === 'compose/default');
    const masks = standard.filter(row => row.source === '/dev/null' && row.destination.includes('.config/gh/hosts.yml'));
    expect(masks.map(row => row.destination)).toEqual(expect.arrayContaining([
      '<HOME>/.config/gh/hosts.yml', '/host<HOME>/.config/gh/hosts.yml',
    ]));
    expect(masks.every(row => row.access === 'ro')).toBe(true);
  });

  it('uses fixture-controlled optional mounts and includes normal Copilot and runner-temp shares', async () => {
    const rows = await collectSharingRows();
    const standard = rows.filter(row => row.scenario === 'compose/default');
    expect(standard).toContainEqual(expect.objectContaining({
      source: '/etc/pki/ca-trust/extracted',
    }));
    expect(standard.some(row => row.source === '/etc/pki/tls/certs')).toBe(false);
    expect(standard).toContainEqual(expect.objectContaining({
      source: '<HOME>/.copilot', destination: '/host<HOME>/.copilot', access: 'rw',
    }));
    expect(rows).toContainEqual(expect.objectContaining({
      scenario: 'cloud-hypervisor/workspace-only',
      source: '<FIXTURE>/runner-temp/gh-aw',
      destination: '<FIXTURE>/runner-temp/gh-aw',
      access: 'ro',
    }));
  });

  it('records tmpfs targets separately from options and preserves sensitive-mask provenance', async () => {
    const rows = await collectSharingRows();
    const masks = rows.filter(row =>
      row.scenario === 'compose/default' && row.consumer === 'agent' &&
      row.provenance === 'sensitive-path mask');
    expect(masks).toContainEqual(expect.objectContaining({
      destination: '/tmp/gh-aw/mcp-logs',
      access: 'rw (tmpfs; rw,noexec,nosuid,size=1m)',
    }));
    expect(masks).not.toContainEqual(expect.objectContaining({
      destination: '/tmp/gh-aw/mcp-logs:rw,noexec,nosuid,size=1m',
    }));
    expect(renderSharingRows(masks)).toContain('sensitive-path confidentiality mask');
    expect(parseTmpfsEntry('/tmp/private:ro,noexec')).toEqual({
      target: '/tmp/private',
      options: 'ro,noexec',
      access: 'ro (tmpfs; ro,noexec)',
    });
  });

  it('checks enclave root visibility against concrete paths in an enclaves-enabled plan', async () => {
    const rows = await collectSharingRows();
    const scenario = rows.filter(row => row.scenario === 'compose/enclaves-enabled');
    const roots = new Set(scenario
      .filter(row => row.consumer === 'enclave-mcp-server')
      .map(row => row.source.match(/^\/var\/tmp\/awf-enclave-(?:private|control)-[^/]+/)?.[0])
      .filter((root): root is string => root !== undefined));
    expect([...roots].some(root => root.includes('awf-enclave-private-'))).toBe(true);
    expect([...roots].some(root => root.includes('awf-enclave-control-'))).toBe(true);
    const agent = scenario.filter(row => row.consumer === 'agent');
    expect(agent.length).toBeGreaterThan(0);
    for (const row of agent.filter(item => item.source !== '/dev/null')) {
      for (const root of roots) {
        expect(isWithin(root, row.source)).toBe(false);
        if (isWithin(row.source, root)) {
          const exposedTarget = path.posix.join(row.destination, path.posix.relative(row.source, root));
          const overlays = agent.filter(item => item.source === '/dev/null');
          expect(overlays.some(mask =>
            mask.destination === exposedTarget ||
            mask.destination === `/host${exposedTarget}` ||
            exposedTarget === `/host${mask.destination}`)).toBe(true);
        }
      }
    }
  });

  it('does not alter the legacy init mountpoint on the host while collecting rows', async () => {
    const snapshot = () => {
      try {
        const stats = fs.lstatSync('/tmp/awf-init');
        return {
          dev: stats.dev, ino: stats.ino, mode: stats.mode,
          uid: stats.uid, gid: stats.gid, mtimeMs: stats.mtimeMs,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    };
    const before = snapshot();
    await collectSharingRows();
    expect(snapshot()).toEqual(before);
  });

  it('does not upgrade read-only mounts when allowWrite is empty', async () => {
    const rows = await collectSharingRows();
    const baseline = rows.filter(row => row.scenario === 'compose/default' && row.consumer === 'agent');
    const restricted = rows.filter(row => row.scenario === 'compose/allowWrite-empty' && row.consumer === 'agent');
    for (const mount of baseline.filter(row => row.access === 'ro' && row.source !== '/dev/null')) {
      expect(restricted).toContainEqual({ ...mount, scenario: 'compose/allowWrite-empty' });
    }
    expect(restricted).toContainEqual(expect.objectContaining({
      source: '/dev/null', destination: '/host<HOME>/.config/gh/hosts.yml', access: 'ro',
    }));
    expect(restricted.find(row => row.source === '<FIXTURE>/workspace' &&
      row.destination === '<FIXTURE>/workspace')?.access).toBe('ro');
    const channel = baseline.filter(row => row.source === '<FIXTURE>/work/init-signal');
    expect(channel).toEqual(expect.arrayContaining([
      expect.objectContaining({ destination: '/run/awf-init', access: 'rw' }),
      expect.objectContaining({ destination: '/tmp/awf-init', access: 'ro' }),
    ]));
    expect(rows.filter(row => row.scenario === 'cloud-hypervisor/workspace-and-tool-cache'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ source: '<FIXTURE>/tools', access: 'ro' }),
      ]));
    expect(rows.filter(row => row.scenario === 'nvx/workspace-and-tool-cache'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ source: '<FIXTURE>/tools', access: 'ro' }),
      ]));
  });
});
