import { collectSharingRows, renderSharingRows, updateContract } from './filesystem-sharing-contract';

describe('filesystem sharing contract', () => {
  it('matches final builder/export plans', async () => {
    await expect(updateContract(false)).resolves.toBeUndefined();
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
    const masks = standard.filter(row => row.source === '/dev/null' && row.destination.includes('.docker/config.json'));
    expect(masks.map(row => row.destination)).toEqual(expect.arrayContaining([
      '<HOME>/.docker/config.json', '/host<HOME>/.docker/config.json',
    ]));
    expect(masks.every(row => row.access === 'ro')).toBe(true);
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
