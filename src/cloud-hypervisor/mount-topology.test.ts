import { observeMountTopology, cloneMountTopology, type MountTopologyEvidence } from './mount-topology';
import { hostPreflightReason } from './host-preflight-progress';
import schema from './mount-topology-schema.json';

const root = '/private/SECRET';
const artifacts = `${root}/artifacts`;
const snapshot = `${artifacts}/run-sensitive`;
const line = (id: number, parent: number, backing: string, target: string, optional = '') =>
  `${id} ${parent} 0:50 ${backing} ${target} rw ${optional}- tmpfs awf-enclave-invocation rw\n`;
const base = (optional = '') => line(100, 1, '/', root, optional) + line(101, 100, '/artifacts', artifacts, optional);

describe('bounded snapshot topology evidence', () => {
  it('identifies overlapping local peers and a distinct-ID snapshot stack without disclosing identifiers', () => {
    const value = observeMountTopology(base('shared:19 ') +
      line(102, 101, '/artifacts/run-sensitive', snapshot, 'shared:20 ') +
      line(103, 102, '/artifacts/run-sensitive', snapshot, 'shared:20 '), root, artifacts, snapshot);
    expect(value).toEqual({
      rootPropagation: 'shared', artifactsPropagation: 'shared', localPeerRelation: 'same-group-overlap',
      visibleOutsidePeers: 'absent', snapshotEntries: 'multiple', snapshotIds: 'unique', snapshotParentStack: 'present',
    });
    expect(JSON.stringify(value)).not.toMatch(/private|SECRET|sensitive|19|20|100|101|102|103/);
  });

  it.each([
    ['', 'private'],
    ['shared:19 ', 'shared'],
    ['master:19 ', 'slave'],
    ['shared:20 master:19 propagate_from:18 ', 'shared-slave'],
    ['unbindable ', 'unbindable'],
  ] as const)('reports %s propagation as %s', (optional, expected) => {
    const value = observeMountTopology(base(optional), root, artifacts, snapshot);
    expect(value.rootPropagation).toBe(expected);
    expect(value.artifactsPropagation).toBe(expected);
    expect(value.snapshotEntries).toBe('zero');
  });

  it('distinguishes visible outside peers from different local groups', () => {
    const text = line(100, 1, '/', root, 'shared:19 ') + line(101, 100, '/artifacts', artifacts, 'shared:20 ') +
      line(200, 1, '/', '/outside/SECRET', 'shared:20 ');
    expect(observeMountTopology(text, root, artifacts, snapshot)).toMatchObject({
      localPeerRelation: 'different-group', visibleOutsidePeers: 'present',
    });
  });

  it('does not infer absent external peers when the parent identity is ambiguous', () => {
    const value = observeMountTopology(base('shared:19 ') + line(200, 100, '/', root), root, artifacts, snapshot);
    expect(value).toMatchObject({
      rootPropagation: 'unknown', localPeerRelation: 'unknown', visibleOutsidePeers: 'unknown',
    });
  });

  it.each([
    ['identical', [102, 102], 'repeated'],
    ['distinct', [102, 103], 'unique'],
    ['mixed', [102, 102, 103], 'mixed'],
  ] as const)('distinguishes %s snapshot IDs', (_kind, ids, expected) => {
    const value = observeMountTopology(base() + ids.map((id) =>
      line(id, 101, '/artifacts/run-sensitive', snapshot)).join(''), root, artifacts, snapshot);
    expect(value.snapshotIds).toBe(expected);
    expect(value.snapshotParentStack).toBe(expected === 'unique' ? 'absent' : 'unknown');
  });

  it('accepts escaped paths and unknown optional fields', () => {
    const value = observeMountTopology(base('future:field ') +
      line(102, 101, '/artifacts/run-sensitive', snapshot.replace('run-sensitive', '\\162un-sensitive')),
    root, artifacts, snapshot);
    expect(value).toMatchObject({ snapshotEntries: 'one', snapshotIds: 'unique', rootPropagation: 'private' });
  });

  it.each(['shared:bad ', 'shared:1 shared:2 ', 'master:0 ', 'master:1 master:2 '])(
    'rejects ambiguous topology %s without inventing evidence', (optional) => {
      try {
        observeMountTopology(base(optional), root, artifacts, snapshot);
        throw new Error('expected rejection');
      } catch (error) { expect(hostPreflightReason(error)).toBe('mountinfo-malformed'); }
    },
  );

  it('clones fixed observations without aliasing earlier evidence', () => {
    const observation = observeMountTopology(base(), root, artifacts, snapshot);
    const evidence: MountTopologyEvidence = { schemaVersion: 1, bindCalls: 'one', before: observation, after: null };
    const clone = cloneMountTopology(evidence);
    clone.before!.snapshotEntries = 'multiple';
    expect(evidence.before!.snapshotEntries).toBe('zero');
    for (const [key, values] of Object.entries(schema)) {
      expect(values).toContain(observation[key as keyof typeof observation]);
    }
  });

  it('refuses extra fields and arbitrary strings even when passed through a typed caller', () => {
    const observation = observeMountTopology(base(), root, artifacts, snapshot);
    const evidence: MountTopologyEvidence = { schemaVersion: 1, bindCalls: 'one', before: observation, after: null };
    const extraObservation = { ...evidence, before: { ...observation, path: 'SECRET' } };
    const extraEvidence = { ...evidence, path: 'SECRET' };
    expect(() => cloneMountTopology(extraObservation))
      .toThrow('Invalid bounded mount topology observation');
    expect(() => cloneMountTopology(extraEvidence)).toThrow();
    Object.assign(observation, { snapshotIds: 'SECRET' });
    expect(() => cloneMountTopology(evidence)).toThrow();
  });
});
