import { promises as fs } from 'fs';
import type { PathLike } from 'fs';
import * as path from 'path';
import {
  DurableCloudHypervisorCleanupRegistry,
} from './cleanup-registry';
import { createCleanupRegistryTestHarness } from './cleanup-registry.test-support';

describe('DurableCloudHypervisorCleanupRegistry orchestration', () => {
  let harness: Awaited<ReturnType<typeof createCleanupRegistryTestHarness>>;

  beforeEach(async () => {
    harness = await createCleanupRegistryTestHarness();
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  describe('record creation and VMM cleanup', () => {
    it('atomically creates a private record before any resource identity is live', async () => {
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const paths = harness.runPaths('recorded-run');
      const plan = harness.networkPlan(paths.runId);

      await registry.create(paths, plan, process.execPath, '/usr/bin/ip');

      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', 'recorded-run.json');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        owner: { pid: number; startTime: string; executable: string };
        paths: { runDirectory: string; cgroupPath: string };
        network: { namespaceName: string; hostVethName: string; tapName: string };
        identities: Record<string, unknown>;
      };
      expect(record.owner).toMatchObject({
        pid: 4242,
        startTime: '1000',
        executable: await fs.realpath(process.execPath),
      });
      expect(record.paths).toEqual({
        runDirectory: paths.runDirectory,
        cgroupPath: paths.cgroupPath,
        virtiofsdShareDirectory: paths.virtiofsdShareDirectory,
      });
      expect(record.network).toMatchObject({
        namespaceName: plan.namespaceName,
        hostVethName: plan.hostVethName,
        tapName: plan.tapName,
      });
      expect(record.identities).toEqual({});
      expect((await fs.stat(recordPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(path.dirname(recordPath))).mode & 0o777).toBe(0o700);
    });

    it('journals and reaps the exact dedicated VMM account and ACL identity', async () => {
      const paths = harness.runPaths('vmm-account-recovery');
      const account = 'awfvmm-0123456789abcdef0123';
      let userExists = true;
      let groupExists = true;
      let aclExists = true;
      const tools = {
        getfacl: '/usr/bin/getfacl',
        getent: '/usr/bin/getent',
        groupdel: '/usr/sbin/groupdel',
        id: '/usr/bin/id',
        ip: '/usr/bin/ip',
        setfacl: '/usr/bin/setfacl',
        useradd: '/usr/sbin/useradd',
        userdel: '/usr/sbin/userdel',
      };
      const run = jest.fn(async (command: string, args: readonly string[]) => {
        if (command === tools.getent && args[0] === 'passwd') {
          return userExists
            ? {
              exitCode: 0,
              stdout: `${account}:x:23001:23002:AWF Cloud Hypervisor ${paths.runId}:` +
                '/nonexistent:/usr/sbin/nologin\n',
              stderr: '',
            }
            : { exitCode: 2, stdout: '', stderr: '' };
        }
        if (command === tools.getent && args[0] === 'group') {
          return groupExists
            ? { exitCode: 0, stdout: `${account}:x:23002:\n`, stderr: '' }
            : { exitCode: 2, stdout: '', stderr: '' };
        }
        if (command === tools.getfacl) {
          return {
            exitCode: 0,
            stdout: aclExists ? 'user:23001:rw-\n' : '',
            stderr: '',
          };
        }
        if (command === tools.id) {
          if (!userExists) return { exitCode: 1, stdout: '', stderr: '' };
          if (args[0] === '-u') return { exitCode: 0, stdout: '23001\n', stderr: '' };
          return { exitCode: 0, stdout: '23002\n', stderr: '' };
        }
        if (command === tools.setfacl) aclExists = false;
        if (command === tools.userdel) userExists = false;
        if (command === tools.groupdel) groupExists = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ run }));
      const handle = await registry.createPending(paths, process.execPath, tools.ip);
      const snapshot = path.join(paths.runBaseDir, 'trusted-artifacts', 'run-snapshot');
      await fs.mkdir(snapshot, { recursive: true });
      await handle.captureArtifactSnapshot(snapshot);
      await handle.prepareVmmAccount(account);
      await handle.captureVmmIdentity({ name: account, uid: 23001, gid: 23002 });
      await handle.prepareVmmAcl('/dev/kvm');
      harness.state.ownerStartTime = '2000';

      await registry.reapPending(tools.ip, '/usr/bin/umount', tools);

      expect(run).toHaveBeenCalledWith(tools.setfacl, ['--remove', 'user:23001', '/dev/kvm']);
      expect(run).toHaveBeenCalledWith(tools.userdel, [account]);
      expect(run).toHaveBeenCalledWith(tools.groupdel, [account]);
      await expect(fs.access(snapshot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
      )).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('requires root and refuses to replace an existing run record', async () => {
      const paths = harness.runPaths('exclusive-record');
      const plan = harness.networkPlan(paths.runId);
      await expect(new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ effectiveUid: 1000 }),
      ).create(paths, plan, process.execPath, '/usr/bin/ip')).rejects.toThrow(
        /requires effective uid 0/,
      );

      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      await expect(registry.create(paths, plan, process.execPath, '/usr/bin/ip')).rejects.toThrow(
        /Cleanup record already exists/,
      );
    });

    it('preserves the publication error when temporary-file cleanup also races', async () => {
      const paths = harness.runPaths('publication-failure');
      const link = jest.fn(async () => {
        throw Object.assign(new Error('filesystem denied link'), { code: 'EPERM' });
      }) as typeof fs.link;
      const unlink = jest.fn(async () => {
        throw Object.assign(new Error('temporary file already gone'), { code: 'ENOENT' });
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ link, unlink }));

      await expect(registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      )).rejects.toThrow(/filesystem denied link/);
      expect((await fs.readdir(path.join(harness.temporaryRoot, 'pending-cleanup')))).toHaveLength(1);
    });
  });

  describe('stale ownership and claim orchestration', () => {
    it('retains a stale record when a prepared process identity was never committed', async () => {
      const paths = harness.runPaths('pending-process');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.prepareProcess('worker', process.execPath, '/sock');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /launch identity was never committed/,
      );
      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
      )).resolves.toBeUndefined();
    });

    it('skips a live owner so sibling runs cannot reap each other', async () => {
      const deps = harness.dependencies();
      const registry = new DurableCloudHypervisorCleanupRegistry(deps);
      const paths = harness.runPaths('active-run');
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).resolves.toBeUndefined();
      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'active-run.json'),
      )).resolves.toBeUndefined();
      expect(deps.kill).not.toHaveBeenCalled();
    });

    it('keeps a live owner active when its executable pathname was atomically replaced', async () => {
      const deps = harness.dependencies();
      const registry = new DurableCloudHypervisorCleanupRegistry(deps);
      const paths = harness.runPaths('upgraded-owner');
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      harness.state.ownerExecutableLink = `${process.execPath} (deleted)`;

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'upgraded-owner.json'),
      )).resolves.toBeUndefined();
      expect(deps.kill).not.toHaveBeenCalled();
    });

    it('reaps an abandoned pre-resource record after owner PID reuse', async () => {
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const paths = harness.runPaths('stale-run');
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'stale-run.json'),
      )).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('atomically takes over and removes a stale cleanup claim', async () => {
      const paths = harness.runPaths('stale-claim');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', 'stale-claim.json');
      const claimedPath = `${recordPath}.lock-claimed-owner`;
      const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
        if (String(filePath) === claimedPath) {
          await fs.unlink(filePath);
          throw Object.assign(new Error('claim already released'), { code: 'ENOENT' });
        }
        return fs.unlink(filePath);
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ unlink }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
      await fs.writeFile(`${recordPath}.lock`, `${JSON.stringify(record.owner)}\n`, { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      const names = await fs.readdir(path.dirname(recordPath));
      expect(names.filter((name) => name.startsWith('stale-claim.json'))).toEqual([]);
    });

    it('abandons takeover if the existing claim lock inode changes', async () => {
      const paths = harness.runPaths('claim-inode-race');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const lockPath = `${recordPath}.lock`;
      const base = harness.dependencies();
      const baseLstat = base.lstat as typeof fs.lstat;
      let lockStats = 0;
      const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
        const value = await baseLstat(filePath, options as never);
        if (
          String(filePath) === lockPath &&
          (options as { bigint?: boolean } | undefined)?.bigint &&
          ++lockStats === 2
        ) {
          return Object.assign(value, { ino: BigInt(value.ino) + 1n });
        }
        return value;
      }) as typeof fs.lstat;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ lstat }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
      await fs.writeFile(lockPath, JSON.stringify(record.owner), { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      await expect(fs.access(recordPath)).resolves.toBeUndefined();
    });

    it('fails closed on a corrupted renamed cleanup claim', async () => {
      const paths = harness.runPaths('corrupt-renamed-claim');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await fs.writeFile(`${recordPath}.lock-claimed-corrupt`, '{', { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /cleanup claim is unreadable/,
      );
    });

    it('surfaces failure to release a newly acquired cleanup claim', async () => {
      const paths = harness.runPaths('claim-release-failure');
      const lockPath = path.join(
        harness.temporaryRoot,
        'pending-cleanup',
        `${paths.runId}.json.lock`,
      );
      const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
        if (String(filePath) === lockPath) {
          throw Object.assign(new Error('claim release denied'), { code: 'EPERM' });
        }
        return fs.unlink(filePath);
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ unlink }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /claim release denied/,
      );
    });

    it('surfaces failure to discard a stale renamed cleanup claim', async () => {
      const paths = harness.runPaths('stale-renamed-release');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const claimPath = `${recordPath}.lock-claimed-stale`;
      const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
        if (String(filePath) === claimPath) {
          throw Object.assign(new Error('stale claim removal denied'), { code: 'EPERM' });
        }
        return fs.unlink(filePath);
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ unlink }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        owner: Record<string, unknown>;
      };
      await fs.writeFile(claimPath, JSON.stringify({
        ...record.owner,
        pid: 9999,
        startTime: '9999',
      }), { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /stale claim removal denied/,
      );
    });

    it('honors active renamed claims and removes stale renamed claims', async () => {
      const paths = harness.runPaths('renamed-claim');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', 'renamed-claim.json');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        owner: Record<string, unknown>;
      };
      const claimPath = `${recordPath}.lock-claimed-active`;
      await fs.writeFile(claimPath, JSON.stringify({
        ...record.owner,
        pid: 5000,
        startTime: '5000',
        networkNamespace: harness.state.daemonNamespace,
      }), { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');
      await expect(fs.access(recordPath)).resolves.toBeUndefined();

      harness.state.daemonAlive = false;
      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');
      await expect(fs.access(recordPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(claimPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('rejects unsafe or unreadable cleanup claims', async () => {
      for (const [runId, contents, mode, expected] of [
        ['unsafe-claim', '{}', 0o644, /claim has unsafe ownership or mode/],
        ['unreadable-claim', '{', 0o600, /claim is unreadable/],
      ] as const) {
        const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
        const paths = harness.runPaths(runId);
        await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
        await fs.writeFile(
          path.join(harness.temporaryRoot, 'pending-cleanup', `${runId}.json.lock`),
          contents,
          { mode },
        );
        harness.state.ownerStartTime = '2000';
        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(expected);
        harness.state.ownerStartTime = '1000';
      }
    });

    it('leaves a stale record untouched when another reaper wins the takeover marker', async () => {
      const paths = harness.runPaths('claim-takeover-race');
      const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
        if (String(destination).endsWith('.lock-claimed-owner')) {
          throw Object.assign(new Error('claimed'), { code: 'EEXIST' });
        }
        return fs.link(source, destination);
      }) as typeof fs.link;
      const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
        if (String(filePath).includes('.lock-claimed-owner.tmp-')) {
          throw Object.assign(new Error('temporary marker gone'), { code: 'ENOENT' });
        }
        return fs.unlink(filePath);
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ link, unlink }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as { owner: unknown };
      await fs.writeFile(`${recordPath}.lock`, JSON.stringify(record.owner), { mode: 0o600 });
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      await expect(fs.access(recordPath)).resolves.toBeUndefined();
    });

    it('backs off when a live renamed claimant appears immediately after lock acquisition', async () => {
      const paths = harness.runPaths('late-renamed-claim');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const claim = { owner: undefined as Record<string, unknown> | undefined };
      const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
        await fs.link(source, destination);
        if (String(destination) === `${recordPath}.lock` && claim.owner) {
          await fs.writeFile(
            `${recordPath}.lock-claimed-racer`,
            JSON.stringify(claim.owner),
            { mode: 0o600 },
          );
        }
      }) as typeof fs.link;
      const unlink: typeof fs.unlink = (async (filePath: PathLike) => {
        if (String(filePath) === `${recordPath}.lock`) {
          await fs.unlink(filePath);
          throw Object.assign(new Error('lock already removed'), { code: 'ENOENT' });
        }
        return fs.unlink(filePath);
      }) as typeof fs.unlink;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ link, unlink }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      const record = JSON.parse(await fs.readFile(recordPath, 'utf8')) as {
        owner: Record<string, unknown>;
      };
      claim.owner = {
        ...record.owner,
        pid: 5000,
        startTime: '5000',
        networkNamespace: harness.state.daemonNamespace,
      };
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      await expect(fs.access(recordPath)).resolves.toBeUndefined();
      await expect(fs.access(`${recordPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails visibly after a contended claim lock repeatedly vanishes', async () => {
      const paths = harness.runPaths('vanishing-claim');
      const recordPath = path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`);
      const link: typeof fs.link = (async (source: PathLike, destination: PathLike) => {
        if (String(destination) === `${recordPath}.lock`) {
          throw Object.assign(new Error('contended'), { code: 'EEXIST' });
        }
        return fs.link(source, destination);
      }) as typeof fs.link;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ link }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /could not atomically claim stale cleanup record/,
      );
    });
  });

  describe('resource recovery', () => {
    it('retains evidence and fails when a live resource lacks a committed identity', async () => {
      const base = harness.dependencies();
      const originalLstat = base.lstat as typeof fs.lstat;
      const plan = harness.networkPlan('uncertain-run');
      const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
        if (String(filePath) === plan.netnsPath) {
          const bigint = Boolean((options as { bigint?: boolean } | undefined)?.bigint);
          return {
            dev: bigint ? 1n : 1,
            ino: bigint ? 2n : 2,
            uid: bigint ? 0n : 0,
            mode: bigint ? 0o100600n : 0o100600,
            isFile: () => true,
            isDirectory: () => false,
            isSymbolicLink: () => false,
          };
        }
        return originalLstat(filePath, options as never);
      }) as typeof fs.lstat;
      const registry = new DurableCloudHypervisorCleanupRegistry({ ...base, lstat });
      const paths = harness.runPaths(plan.runId);
      await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /netns exists but its immutable identity was never committed/,
      );
      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', 'uncertain-run.json'),
      )).resolves.toBeUndefined();
    });

    it('revalidates and unmounts recorded virtiofs bind mounts deepest-first', async () => {
      const run = jest.fn(async (command: string, args: readonly string[]) => {
        if (command === '/usr/bin/umount') {
          harness.state.mountInfo = harness.state.mountInfo
            .split('\n')
            .filter((line) => line && !line.includes(` ${args[0]} `))
            .join('\n');
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 1, stdout: '', stderr: 'Device does not exist' };
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ run }));
      const paths = harness.runPaths('mounted-run');
      const mountPoint = path.join(paths.virtiofsdShareDirectory, '0-workspace');
      const nestedMountPoint = path.join(mountPoint, 'nested');
      await fs.mkdir(nestedMountPoint, { recursive: true });
      harness.state.mountInfo = [
        `123 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw`,
        `124 123 8:1 /source/nested ${nestedMountPoint} rw - ext4 /dev/sda1 rw`,
        '',
      ].join('\n');
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureVirtiofsdResources();
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      expect(run.mock.calls.filter(([command]) => command === '/usr/bin/umount')).toEqual([
        ['/usr/bin/umount', [nestedMountPoint]],
        ['/usr/bin/umount', [mountPoint]],
      ]);
      await expect(fs.access(paths.virtiofsdShareDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('captures and identity-validates every live resource during stale-run recovery', async () => {
      const paths = harness.runPaths('full-recovery');
      const plan = harness.networkPlan(paths.runId);
      const netnsIdentityFile = path.join(harness.temporaryRoot, 'netns-identity');
      await fs.writeFile(netnsIdentityFile, '');
      await fs.mkdir(paths.runDirectory, { recursive: true });
      await fs.mkdir(paths.cgroupPath, { recursive: true });
      await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
      const netnsStat = await fs.lstat(netnsIdentityFile, { bigint: true });
      harness.state.daemonNamespace = `net:[${netnsStat.ino}]`;
      let netnsExists = true;
      let firewallRuleExists = true;
      const interfaces = new Map([
        [plan.hostVethName, 101],
        [plan.namespaceVethName, 102],
        [plan.tapName, 103],
      ]);
      const base = harness.dependencies();
      const baseLstat = base.lstat as typeof fs.lstat;
      const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
        if (String(filePath) === plan.netnsPath) {
          if (!netnsExists) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
          return fs.lstat(netnsIdentityFile, options as never);
        }
        return baseLstat(filePath, options as never);
      }) as typeof fs.lstat;
      const run = jest.fn(async (command: string, args: readonly string[]) => {
        if (command === '/usr/bin/ip' && args.includes('-json')) {
          const name = args[args.length - 1];
          const ifindex = interfaces.get(name);
          return ifindex === undefined
            ? { exitCode: 1, stdout: '', stderr: 'Device does not exist' }
            : { exitCode: 0, stdout: JSON.stringify([{ ifname: name, ifindex }]), stderr: '' };
        }
        if (command === '/usr/bin/ip' && args[0] === 'link' && args[1] === 'delete') {
          interfaces.delete(args[2]);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === '/usr/bin/ip' && args[0] === 'netns' && args[1] === 'delete') {
          netnsExists = false;
          interfaces.delete(plan.namespaceVethName);
          interfaces.delete(plan.tapName);
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        if (command === 'iptables' && args.includes('-C')) {
          return { exitCode: firewallRuleExists ? 0 : 1, stdout: '', stderr: '' };
        }
        if (command === 'iptables' && args.includes('-D')) {
          firewallRuleExists = false;
          return { exitCode: 0, stdout: '', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      const kill = jest.fn((_pid: number, signal?: NodeJS.Signals | number) => {
        if (signal === 'SIGTERM') harness.state.daemonAlive = false;
        return true as const;
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ lstat, run, kill }),
      );
      const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      await handle.captureNetworkResource('netns');
      await handle.captureNetworkResource('hostVeth');
      await handle.captureNetworkResource('namespaceVeth');
      await handle.captureNetworkResource('tap');
      await handle.captureRunDirectory();
      await handle.captureCgroup();
      await handle.captureVirtiofsdResources();
      await handle.prepareProcess('vmm', process.execPath, '/sock');
      await handle.captureProcess('vmm', 5000);
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      expect(kill).toHaveBeenCalledWith(5000, 'SIGTERM');
      expect(netnsExists).toBe(false);
      expect(interfaces.size).toBe(0);
      expect(firewallRuleExists).toBe(false);
      await expect(fs.access(paths.runDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(paths.cgroupPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(paths.virtiofsdShareDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(
        path.join(harness.temporaryRoot, 'pending-cleanup', `${paths.runId}.json`),
      )).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  describe('resource revalidation failures', () => {
    it('retains evidence when bridge-rule revalidation is uncertain', async () => {
      const paths = harness.runPaths('iptables-uncertain');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({
        run: jest.fn(async (command: string) => (
          command === 'iptables'
            ? { exitCode: 2, stdout: '', stderr: 'xtables lock busy' }
            : { exitCode: 1, stdout: '', stderr: 'Device does not exist' }
        )),
      }));
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /Could not revalidate per-run bridge rule: xtables lock busy/,
      );
    });

    it('retains evidence when an identity-validated network deletion command fails', async () => {
      const paths = harness.runPaths('network-delete-failure');
      const plan = harness.networkPlan(paths.runId);
      const run = jest.fn(async (_command: string, args: readonly string[]) => {
        if (args.includes('-json')) {
          return {
            exitCode: 0,
            stdout: JSON.stringify([{ ifname: plan.hostVethName, ifindex: 41 }]),
            stderr: '',
          };
        }
        if (args[0] === 'link' && args[1] === 'delete') {
          return { exitCode: 2, stdout: '', stderr: 'device busy' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ run }));
      const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      await handle.captureNetworkResource('hostVeth');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /link delete.*failed with code 2: device busy/,
      );
    });

    it('retains evidence when a recorded mount identity changes', async () => {
      const paths = harness.runPaths('changed-mount');
      const mountPoint = path.join(paths.virtiofsdShareDirectory, 'workspace');
      await fs.mkdir(mountPoint, { recursive: true });
      harness.state.mountInfo = `123 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw\n`;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureVirtiofsdResources();
      harness.state.mountInfo = `124 1 8:1 /source ${mountPoint} rw - ext4 /dev/sda1 rw\n`;
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /mount identity changed/,
      );
    });

    it('refuses recursive deletion when an unrecorded mount appears', async () => {
      const paths = harness.runPaths('late-mount');
      await fs.mkdir(paths.virtiofsdShareDirectory, { recursive: true });
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureVirtiofsdResources();
      harness.state.mountInfo = `123 1 8:1 / ${paths.virtiofsdShareDirectory} rw - ext4 /dev/sda1 rw\n`;
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /refusing recursive removal while mounts remain/,
      );
    });

    it('fails when the kernel does not release a cgroup before the retry deadline', async () => {
      const paths = harness.runPaths('cgroup-timeout');
      await fs.mkdir(paths.cgroupPath, { recursive: true });
      const rmdir = jest.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }) as typeof fs.rmdir;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ rmdir }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureCgroup();
      harness.state.ownerStartTime = '2000';
      const now = jest.spyOn(Date, 'now')
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(6_000);
      try {
        await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow('busy');
      } finally {
        now.mockRestore();
      }
    });

    it('retries inode-validated cgroup removal while kernel accounting drains', async () => {
      const paths = harness.runPaths('cgroup-drain');
      await fs.mkdir(paths.cgroupPath, { recursive: true });
      let attempts = 0;
      const rmdir = jest.fn(async (directory: PathLike) => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        await fs.rmdir(directory);
      }) as typeof fs.rmdir;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ rmdir }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureCgroup();
      harness.state.ownerStartTime = '2000';

      await registry.reapPending('/usr/bin/ip', '/usr/bin/umount');

      expect(rmdir).toHaveBeenCalledTimes(2);
      await expect(fs.access(paths.cgroupPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('fails if a cgroup inode changes while kernel accounting drains', async () => {
      const paths = harness.runPaths('changed-cgroup');
      await fs.mkdir(paths.cgroupPath, { recursive: true });
      let cgroupStats = 0;
      const base = harness.dependencies();
      const baseLstat = base.lstat as typeof fs.lstat;
      const lstat: typeof fs.lstat = (async (filePath: PathLike, options?: unknown) => {
        const value = await baseLstat(filePath, options as never);
        if (
          String(filePath) === paths.cgroupPath &&
          (options as { bigint?: boolean } | undefined)?.bigint &&
          ++cgroupStats >= 4
        ) {
          return Object.assign(value, { ino: BigInt(value.ino) + 1n });
        }
        return value;
      }) as typeof fs.lstat;
      const rmdir = jest.fn(async () => {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }) as typeof fs.rmdir;
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ lstat, rmdir }));
      const handle = await registry.create(
        paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip',
      );
      await handle.captureCgroup();
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /identity changed during cgroup drain/,
      );
    });

    it('fails when an interface is replaced after its identity is committed', async () => {
      const paths = harness.runPaths('changed-interface');
      const plan = harness.networkPlan(paths.runId);
      let ifindex = 41;
      const run = jest.fn(async (_command: string, args: readonly string[]) => (
        args.includes('-json')
          ? {
            exitCode: 0,
            stdout: JSON.stringify([{ ifname: plan.hostVethName, ifindex }]),
            stderr: '',
          }
          : { exitCode: 0, stdout: '', stderr: '' }
      ));
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies({ run }));
      const handle = await registry.create(paths, plan, process.execPath, '/usr/bin/ip');
      await handle.captureNetworkResource('hostVeth');
      ifindex = 42;
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /interface ".*" identity changed/,
      );
    });
  });

  describe('permissions and fallback executor behavior', () => {
    it('rejects unsafe registry and record permissions', async () => {
      const unsafeRoot = path.join(harness.temporaryRoot, 'unsafe');
      const unsafeRegistry = path.join(unsafeRoot, 'pending-cleanup');
      await fs.mkdir(unsafeRegistry, { recursive: true, mode: 0o755 });
      await expect(new DurableCloudHypervisorCleanupRegistry(
        harness.dependencies({ rootDirectory: unsafeRoot }),
      ).reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /unsafe ownership or mode/,
      );

      const paths = harness.runPaths('unsafe-record');
      const registry = new DurableCloudHypervisorCleanupRegistry(harness.dependencies());
      await registry.create(paths, harness.networkPlan(paths.runId), process.execPath, '/usr/bin/ip');
      await fs.chmod(path.join(harness.temporaryRoot, 'pending-cleanup', 'unsafe-record.json'), 0o644);
      await expect(registry.reapPending('/usr/bin/ip', '/usr/bin/umount')).rejects.toThrow(
        /not a root-owned mode-0600 regular file/,
      );
    });

    it('runs identity-validated deletion through the default argv-only executor', async () => {
      const paths = harness.runPaths('default-executor');
      const plan = harness.networkPlan(paths.runId);
      const executable = path.join(harness.temporaryRoot, 'fake-ip.js');
      await fs.writeFile(executable, [
        '#!/bin/sh',
        'for name do :; done',
        'case " $* " in *" -json "*) printf \'[{"ifname":"%s","ifindex":42}]\' "$name";; esac',
        '',
      ].join('\n'), { mode: 0o700 });
      const base = harness.dependencies();
      const registry = new DurableCloudHypervisorCleanupRegistry({
        ...base,
        run: undefined,
      });
      const handle = await registry.create(paths, plan, process.execPath, executable);
      await handle.captureNetworkResource('hostVeth');
      harness.state.ownerStartTime = '2000';

      await expect(registry.reapPending(executable, '/usr/bin/umount')).rejects.toThrow(
        /stale cleanup is incomplete/,
      );
    });
  });
});
