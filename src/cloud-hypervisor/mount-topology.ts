import * as path from 'path';
import { parseMountInfoLine, type MountIdentity } from './cleanup-identity';
import { markHostPreflightError } from './host-preflight-progress';
import schema from './mount-topology-schema.json';
import storageSchema from './storage-propagation-schema.json';

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

// Tuple indices map to entries, propagation, IDs and pathMatch in the schema legend.
export type StorageMountObservation = [
  0 | 1 | 2, 0 | 1 | 2 | 3 | 4 | 5, 0 | 1 | 2 | 3, 0 | 1 | 2,
];
export type StoragePropagationSlot =
  | 'rootAfterPrivate' | 'rootAfterLayout' | 'artifactsAfterLayout' | 'runsAfterLayout' | 'rootfsAfterLayout'
  | 'invocationBeforeBind' | 'invocationAfterBind' | 'invocationAfterRemount'
  | 'rootVerified' | 'invocationVerified' | 'runsVerified' | 'rootfsVerified' | 'artifactsVerified' | 'snapshotVerified';
export interface StoragePropagationEvidence {
  schemaVersion: 1;
  invocationLocation: 'inside' | 'outside';
  sourceBeforeBind: Propagation | null;
  destinationBeforeBind: Propagation | null;
  mounts: Record<StoragePropagationSlot, StorageMountObservation | null>;
}

export function createStoragePropagationEvidence(root: string, invocation: string): StoragePropagationEvidence {
  return {
    schemaVersion: 1, invocationLocation: invocation.startsWith(`${root}/`) ? 'inside' : 'outside',
    sourceBeforeBind: null, destinationBeforeBind: null,
    mounts: {
      rootAfterPrivate: null, rootAfterLayout: null, artifactsAfterLayout: null,
      runsAfterLayout: null, rootfsAfterLayout: null, invocationBeforeBind: null,
      invocationAfterBind: null, invocationAfterRemount: null, rootVerified: null,
      invocationVerified: null, runsVerified: null, rootfsVerified: null, artifactsVerified: null,
      snapshotVerified: null,
    },
  };
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

export function observeStorageMount(text: string, target: string): StorageMountObservation {
  const mounts = parseTable(text);
  const matches = mounts.filter((mount) => mount.mountPoint === target);
  const ids = new Set(matches.map((mount) => mount.mountId));
  const state = propagation(matches.length === 1 ? matches[0] : undefined);
  return [
    matches.length === 0 ? 0 : matches.length === 1 ? 1 : 2,
    state === 'private' ? 0 : state === 'shared' ? 1 : state === 'slave' ? 2 :
      state === 'shared-slave' ? 3 : state === 'unbindable' ? 4 : 5,
    matches.length === 0 ? 0 : ids.size === matches.length ? 1 : ids.size === 1 ? 2 : 3,
    matches.length ? 0 :
      mounts.some((mount) => path.posix.normalize(mount.mountPoint) === path.posix.normalize(target))
        ? 1 : 2,
  ];
}

/** Observational only: ambiguity is unknown, never authority to select a mount. */
export function observeCoveringPropagation(text: string, target: string): Propagation {
  const mounts = parseTable(text);
  const candidates = mounts.filter((mount) => mount.mountPoint === '/' ||
    mount.mountPoint === target || target.startsWith(`${mount.mountPoint}/`));
  if (new Set(candidates.map((mount) => mount.mountPoint)).size !== candidates.length) return 'unknown';
  const ids = new Map<number, TopologyMount>();
  for (const mount of mounts) {
    if (ids.has(mount.mountId)) return 'unknown';
    ids.set(mount.mountId, mount);
  }
  const ordered = candidates.sort((left, right) => left.mountPoint.length - right.mountPoint.length);
  for (let index = 1; index < ordered.length; index++) {
    const ancestorId = ordered[index - 1].mountId;
    let current: TopologyMount | undefined = ordered[index];
    const visited = new Set<number>();
    let descendsFromAncestor = false;
    while (current && !visited.has(current.mountId)) {
      if (current.mountId === ancestorId) {
        descendsFromAncestor = true;
        break;
      }
      visited.add(current.mountId);
      current = ids.get(current.parentId);
    }
    if (!descendsFromAncestor) return 'unknown';
  }
  return propagation(ordered[ordered.length - 1]);
}

export function assertPrivateStorageObservation(observation: StorageMountObservation): void {
  if (observation[0] !== 1 || observation[1] !== 0) {
    throw markHostPreflightError(new Error('Invocation storage propagation is not private'),
      'storage-mount-propagation');
  }
}

export function assertPrivateStorageMount(text: string, target: string): void {
  assertPrivateStorageObservation(observeStorageMount(text, target));
}

export function cloneStoragePropagation(value: StoragePropagationEvidence): StoragePropagationEvidence {
  if (JSON.stringify(Object.keys(value).sort()) !==
    '["destinationBeforeBind","invocationLocation","mounts","schemaVersion","sourceBeforeBind"]' ||
    value.schemaVersion !== 1 || !storageSchema.location.includes(value.invocationLocation) ||
    [value.sourceBeforeBind, value.destinationBeforeBind].some((item) =>
      item !== null && !storageSchema.propagation.includes(item)) ||
    !value.mounts || JSON.stringify(Object.keys(value.mounts).sort()) !==
      JSON.stringify([...storageSchema.mounts].sort())) {
    throw new Error('Invalid bounded storage propagation evidence');
  }
  const copy = { ...value, mounts: { ...value.mounts } };
  for (const key of storageSchema.mounts as StoragePropagationSlot[]) {
    const item = value.mounts[key];
    if (item !== null && (!Array.isArray(item) || item.length !== 4 ||
      JSON.stringify(Object.keys(item)) !== '["0","1","2","3"]' ||
      item.some((field, index) => !storageSchema.observation[index].includes(field)))) {
      throw new Error('Invalid bounded storage mount observation');
    }
    copy.mounts[key] = item === null ? null : [...item];
  }
  return copy;
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
