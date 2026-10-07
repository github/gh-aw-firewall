import { parseMountInfoLine, type MountIdentity } from './cleanup-identity';
import { markHostPreflightError } from './host-preflight-progress';
import schema from './mount-topology-schema.json';

type Propagation = 'private' | 'shared' | 'slave' | 'shared-slave' | 'unbindable' | 'unknown';
export interface MountTopologyObservation {
  rootPropagation: Propagation;
  artifactsPropagation: Propagation;
  localPeerRelation: 'same-group-overlap' | 'different-group' | 'not-shared' | 'unknown';
  visibleOutsidePeers: 'present' | 'absent' | 'unknown';
  snapshotEntries: 'zero' | 'one' | 'multiple';
  snapshotIds: 'none' | 'unique' | 'repeated' | 'mixed';
  snapshotParentStack: 'present' | 'absent' | 'unknown';
}
export interface MountTopologyEvidence {
  schemaVersion: 1;
  bindCalls: 'zero' | 'one' | 'multiple';
  before: MountTopologyObservation | null;
  after: MountTopologyObservation | null;
}

interface TopologyMount extends MountIdentity {
  parentId: number;
  shared?: string;
  master?: string;
  unbindable: boolean;
}

function parseTopology(line: string): TopologyMount {
  const identity = parseMountInfoLine(line);
  const fields = line.split(' ');
  const parentId = Number(fields[1]);
  const optional = fields.slice(6, fields.indexOf('-'));
  const shared = optional.filter((field) => field.startsWith('shared:'));
  const master = optional.filter((field) => field.startsWith('master:'));
  if (!Number.isSafeInteger(parentId) || parentId < 0 ||
    shared.length > 1 || master.length > 1 ||
    [...shared, ...master].some((field) => !/^(shared|master):[1-9][0-9]*$/.test(field))) {
    throw markHostPreflightError(new Error('Malformed mount topology'), 'mountinfo-malformed');
  }
  return {
    ...identity, parentId, shared: shared[0]?.slice(7), master: master[0]?.slice(7),
    unbindable: optional.includes('unbindable'),
  };
}

function propagation(mount: TopologyMount | undefined): Propagation {
  if (!mount) return 'unknown';
  if (mount.shared && mount.master) return 'shared-slave';
  if (mount.shared) return 'shared';
  if (mount.master) return 'slave';
  return mount.unbindable ? 'unbindable' : 'private';
}

function parseTable(text: string): TopologyMount[] {
  try {
    return text.split(/\r?\n/).filter(Boolean).map(parseTopology);
  } catch (error) {
    throw markHostPreflightError(error, 'mountinfo-malformed');
  }
}

export function validateMountTopology(text: string): void {
  parseTable(text);
}

/** Reduces a private mount table to fixed relationships; no identifiers or paths escape. */
export function observeMountTopology(
  text: string, root: string, artifacts: string, snapshot: string,
): MountTopologyObservation {
  const mounts = parseTable(text);
  const exact = (target: string) => mounts.filter((mount) => mount.mountPoint === target);
  const roots = exact(root);
  const parents = exact(artifacts);
  const rootMount = roots.length === 1 ? roots[0] : undefined;
  const artifactsMount = parents.length === 1 ? parents[0] : undefined;
  const snapshots = exact(snapshot);
  const ids = new Set(snapshots.map((mount) => mount.mountId));
  const localPeerRelation = !rootMount || !artifactsMount ? 'unknown' :
    !rootMount.shared || !artifactsMount.shared ? 'not-shared' :
      rootMount.shared !== artifactsMount.shared ? 'different-group' :
        rootMount.device === artifactsMount.device &&
        (artifactsMount.root === rootMount.root ||
          artifactsMount.root.startsWith(rootMount.root === '/' ? '/' : `${rootMount.root}/`))
          ? 'same-group-overlap' : 'unknown';
  const groups = new Set([rootMount?.shared, artifactsMount?.shared].filter(Boolean));
  const outside = mounts.some((mount) => !!mount.shared && groups.has(mount.shared) &&
    mount.mountPoint !== root && !mount.mountPoint.startsWith(`${root}/`));
  return {
    rootPropagation: propagation(rootMount), artifactsPropagation: propagation(artifactsMount),
    localPeerRelation,
    visibleOutsidePeers: !rootMount || !artifactsMount ? 'unknown' :
      groups.size === 0 ? 'absent' : outside ? 'present' : 'absent',
    snapshotEntries: snapshots.length === 0 ? 'zero' : snapshots.length === 1 ? 'one' : 'multiple',
    snapshotIds: snapshots.length === 0 ? 'none' : ids.size === snapshots.length ? 'unique' :
      ids.size === 1 ? 'repeated' : 'mixed',
    snapshotParentStack: snapshots.length < 2 ? 'absent' : ids.size !== snapshots.length ? 'unknown' :
      snapshots.some((mount) => mount.parentId !== mount.mountId && ids.has(mount.parentId)) ? 'present' : 'absent',
  };
}

export function cloneMountTopology(value: MountTopologyEvidence): MountTopologyEvidence {
  if (value.schemaVersion !== 1 || !['zero', 'one', 'multiple'].includes(value.bindCalls) ||
    JSON.stringify(Object.keys(value).sort()) !== '["after","before","bindCalls","schemaVersion"]') {
    throw new Error('Invalid bounded mount topology evidence');
  }
  const clone = (observation: MountTopologyObservation | null): MountTopologyObservation | null => {
    if (observation === null) return null;
    if (JSON.stringify(Object.keys(observation).sort()) !== JSON.stringify(Object.keys(schema).sort()) ||
      (Object.keys(schema) as (keyof MountTopologyObservation)[]).some((key) =>
        !schema[key].includes(observation[key]))) {
      throw new Error('Invalid bounded mount topology observation');
    }
    return { ...observation };
  };
  return {
    schemaVersion: 1, bindCalls: value.bindCalls,
    before: clone(value.before), after: clone(value.after),
  };
}
