import { promises as fs } from 'fs';
import * as path from 'path';
import {
  assertSafeProcessKey,
  assertSafeRecordPaths,
  decodeMountInfoPath,
  parseMountInfoLine,
  parseStatusIdentity,
  sameFileIdentity,
  sameMountIdentity,
  validateProcessIdentity,
  validateRecord,
} from './cleanup-identity';
import { DurableCloudHypervisorCleanupRegistry } from './cleanup-registry';
import { createCleanupRegistryTestHarness } from './cleanup-registry.test-utils';

describe('cleanup identity primitives', () => {
  let harness: Awaited<ReturnType<typeof createCleanupRegistryTestHarness>>;

  beforeEach(async () => {
    harness = await createCleanupRegistryTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('record and process validation', () => {
    it('rejects cross-run setup and unstable process credentials', async () => {
      const paths = harness.runPaths('scoped-run');
      await expect(new DurableCloudHypervisorCleanupRegistry(harness.dependencies()).create(
        paths, harness.networkPlan('different-run'), process.execPath, '/usr/bin/ip',
      )).rejects.toThrow(/resources are not scoped to one run/);
      expect(() => assertSafeRecordPaths(paths, harness.networkPlan('different-run'))).toThrow(
        /resources are not scoped to one run/,
      );

      expect(() => parseStatusIdentity('Uid:\t0\t1\t0\t0\nGid:\t0\t0\t0\t0\n', 'Uid')).toThrow(
        /Process Uid identities are not stable/,
      );
      expect(() => validateProcessIdentity({
        pid: 1,
        startTime: '1',
        executable: process.execPath,
        executableIdentity: { device: '1', inode: '2' },
        uid: 0,
        gid: 0,
        networkNamespace: 'net:[1]',
      }, 'owner')).toThrow(/owner identity is malformed/);
      expect(() => assertSafeProcessKey('__proto__')).toThrow(/Unsafe cleanup process key/);
    });

    it('rejects malformed or cross-run recovery evidence', async () => {
      const cases: Array<[string, (record: Record<string, any>) => void, RegExp]> = [
        ['bad-version', (record) => { record.version = 2; }, /invalid cleanup record identity/],
        ['bad-run-path', (record) => { record.paths.runDirectory = '/workspace/other'; }, /not run-scoped/],
        ['bad-owner', (record) => { record.owner.pid = 1; }, /owner identity is malformed/],
        ['bad-processes', (record) => { record.processes = []; }, /resource identities are malformed/],
        ['bad-process', (record) => {
          record.processes.worker = { state: 'pending', executable: 'relative', socketPath: '/sock' };
        }, /process record is malformed/],
        ['bad-mount', (record) => {
          record.mounts = [{
            mountId: 0,
            device: '8:1',
            root: '/',
            mountPoint: record.paths.virtiofsdShareDirectory,
            filesystemType: 'ext4',
            source: '/dev/sda1',
          }];
        }, /mount identity is malformed/],
      ];

      for (const [runId, mutate, expected] of cases) {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
        const paths = harness.runPaths(runId);
        await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
        const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${runId}.json`);
        const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as Record<string, any>;
        mutate(record);
        await fs.writeFile(recordPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        expect(() => validateRecord(record as never, recordPath, path.dirname(recordPath))).toThrow(expected);
        harness.state.ownerStartTime = '2000';
        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
        harness.state.ownerStartTime = '1000';
      }
    });
  });

  describe('mount and file identity helpers', () => {
    it('compares and decodes file and mount identities', () => {
      expect(sameFileIdentity({ device: '1', inode: '2' }, { device: '1', inode: '2' })).toBe(true);
      expect(sameFileIdentity({ device: '1', inode: '2' }, { device: '1', inode: '3' })).toBe(false);
      expect(decodeMountInfoPath('/with\\040space')).toBe('/with space');
      expect(parseMountInfoLine('123 1 8:1 /source /mount\\040point rw - ext4 /dev/sda1 rw')).toEqual({
        mountId: 123,
        device: '8:1',
        root: '/source',
        mountPoint: '/mount point',
        filesystemType: 'ext4',
        source: '/dev/sda1',
      });
      expect(sameMountIdentity(
        {
          mountId: 123,
          device: '8:1',
          root: '/source',
          mountPoint: '/mount point',
          filesystemType: 'ext4',
          source: '/dev/sda1',
        },
        {
          mountId: 123,
          device: '8:1',
          root: '/source',
          mountPoint: '/mount point',
          filesystemType: 'ext4',
          source: '/dev/sda1',
        },
      )).toBe(true);
      expect(() => parseMountInfoLine('not mountinfo')).toThrow(/Malformed \/proc\/self\/mountinfo entry/);
    });
  });
});
