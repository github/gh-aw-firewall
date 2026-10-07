import {
  assertPrivateStorageMount, observeMountTopology, cloneMountTopology, type MountTopologyEvidence,
  observeStorageMount, observeCoveringPropagation, createStoragePropagationEvidence, cloneStoragePropagation,
} from './mount-topology';
import { hostPreflightReason } from './host-preflight-progress';
import schema from './mount-topology-schema.json';

const root = '/private/SECRET';
const artifacts = `${root}/artifacts`;
const snapshot = `${artifacts}/run-sensitive`;
const line = (id: number, parent: number, backing: string, target: string, optional = '') =>
  `${id} ${parent} 0:50 ${backing} ${target} rw ${optional}- tmpfs awf-enclave-invocation rw\n`;
const base = (optional = '') => line(100, 1, '/', root, optional) + line(101, 100, '/artifacts', artifacts, optional);

describe('bounded storage propagation evidence', () => {
  it.each([
    ['', [0, 5, 0, 2]],
    [base(), [1, 0, 1, 0]],
    [base('shared:3 master:2 '), [1, 3, 1, 0]],
    [base() + base(), [2, 5, 2, 0]],
    [base() + line(103, 1, '/', root), [2, 5, 1, 0]],
    [base() + base() + line(103, 1, '/', root), [2, 5, 3, 0]],
    [line(100, 1, '/', `${root}/.`), [0, 5, 0, 1]],
  ])('separates row count, propagation, IDs and path spelling', (text, expected) => {
    expect(observeStorageMount(text as string, root)).toEqual(expected);
  });

  it('decodes escaped exact paths and ignores unknown optional tags', () => {
    expect(observeStorageMount(line(100, 1, '/', root.replace('SECRET', '\\123ECRET'), 'future:tag '), root))
      .toEqual([1, 0, 1, 0]);
  });

  it('finds source and destination covering propagation without selecting among stacked parents', () => {
    const text = line(1, 1, '/', '/', 'shared:3 ') + base() +
      line(200, 1, '/', '/private/SECRET-sibling', 'master:2 ');
    expect(observeCoveringPropagation(text, `${root}/state`)).toBe('private');
    expect(observeCoveringPropagation(text, '/outside/invocation')).toBe('shared');
    expect(observeCoveringPropagation(text, '/private/SECRET-sibling/state')).toBe('slave');
    expect(observeCoveringPropagation(text + line(201, 1, '/', root, 'shared:4 '), `${root}/state`)).toBe('unknown');
    expect(observeCoveringPropagation(text + line(202, 1, '/', '/', 'shared:4 '), `${root}/state`)).toBe('unknown');
    expect(observeCoveringPropagation(
      line(1, 1, '/', '/', 'shared:3 ') +
      line(10, 1, '/', '/invocations/sub') +
      line(20, 1, '/', '/invocations', 'shared:4 '),
      '/invocations/sub/run',
    )).toBe('unknown');
    expect(observeCoveringPropagation('', '/outside')).toBe('unknown');
  });

  it('bounds observations and deep-copies every tuple without paths or mount identifiers', () => {
    const evidence = createStoragePropagationEvidence(root, '/outside/SECRET');
    evidence.mounts.rootAfterPrivate = observeStorageMount(base(), root);
    const copy = cloneStoragePropagation(evidence);
    copy.mounts.rootAfterPrivate![1] = 1;
    expect(evidence.mounts.rootAfterPrivate![1]).toBe(0);
    expect(JSON.stringify(copy)).not.toMatch(/SECRET|\/outside|0:50/);
    expect(createStoragePropagationEvidence(root, `${root}/state`).invocationLocation).toBe('inside');
    expect(createStoragePropagationEvidence(root, `${root}-sibling/state`).invocationLocation).toBe('outside');
  });

  it('rejects extra keys, sparse or oversized tuples, omitted slots and arbitrary strings', () => {
    const evidence = createStoragePropagationEvidence(root, '/outside/SECRET');
    const sparse = [1, 0, 1, 0];
    delete sparse[1];
    const malformed = [
      { ...evidence, path: 'SECRET' }, { ...evidence, sourceBeforeBind: 'SECRET' },
      { ...evidence, mounts: {} }, { ...evidence, mounts: { ...evidence.mounts, path: 'SECRET' } },
      { ...evidence, mounts: { ...evidence.mounts, rootVerified: [1, 'SECRET', 1, 0] } },
      { ...evidence, mounts: { ...evidence.mounts, rootVerified: [1, 0, 1, 0, 'SECRET'] } },
      { ...evidence, mounts: { ...evidence.mounts, rootVerified: sparse } },
    ];
    for (const value of malformed) {
      expect(() => cloneStoragePropagation(value as typeof evidence)).toThrow(/Invalid bounded storage/);
    }
  });
});

describe('bounded snapshot topology evidence', () => {
  it('accepts only a uniquely observed private mount without changing the table', () => {
    const table = base();
    expect(() => assertPrivateStorageMount(table, root)).not.toThrow();
    expect(() => assertPrivateStorageMount(base('future:field '), root)).not.toThrow();
  });

  it.each(['shared:1 ', 'master:1 ', 'shared:1 master:2 ', 'unbindable '])(
    'rejects residual %s propagation', (optional) => {
      try {
        assertPrivateStorageMount(base(optional), root);
        throw new Error('expected rejection');
      } catch (error) { expect(hostPreflightReason(error)).toBe('storage-mount-propagation'); }
    },
  );
  it.each(['', base() + base()])('rejects absent or ambiguous allocation mount', (text) => {
    expect(() => assertPrivateStorageMount(text, root)).toThrow('propagation is not private');
  });
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
