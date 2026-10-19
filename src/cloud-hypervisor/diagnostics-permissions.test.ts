import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BoundedOutputCapture,
  collectCloudHypervisorDiagnostics,
  preservePublicEnclaveSession,
  preserveVirtiofsdStartupEvidence,
  writeGuestOutputAudit,
} from './diagnostics';
import { createCloudHypervisorRunPaths } from './manager-types';
import { config, dependencies } from './manager.test-utils';

describe('Cloud Hypervisor diagnostic ownership', () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-ch-audit-'));
  });

  afterEach(async () => {
    await fs.rm(scratch, { recursive: true, force: true });
  });

  it.each(['full diagnostics', 'guest output audit'])(
    'hands off %s with runner ownership and private modes, including existing files',
    async (collection) => {
      const directory = path.join(scratch, 'cloud-hypervisor');
      await fs.mkdir(directory, { mode: 0o755 });
      await fs.writeFile(path.join(directory, 'guest-stdout.raw.log'), 'old', { mode: 0o644 });
      const identity = { uid: process.getuid!(), gid: process.getgid!() };
      const deps = dependencies({
        mkdir: fs.mkdir,
        open: fs.open,
        lstat: fs.lstat,
        realpath: fs.realpath,
        writeFile: fs.writeFile,
        resolveIdentity: jest.fn().mockReturnValue(identity),
      });
      const capture = new BoundedOutputCapture(1024);
      capture.append('private output');
      if (collection === 'guest output audit') {
        await writeGuestOutputAudit(directory, deps, capture, capture);
      } else {
        await collectCloudHypervisorDiagnostics(directory, {
          dependencies: deps,
          paths: createCloudHypervisorRunPaths('/opt/cloud-hypervisor', 'permissions'),
          config: config(),
          stdoutCapture: capture,
          stderrCapture: capture,
          guestStdoutCapture: capture,
          guestStderrCapture: capture,
          network: undefined,
          networkPlan: undefined,
          client: undefined,
          instanceStarted: false,
          lastVmInfo: undefined,
          lastVmCounters: undefined,
          fsDevices: [{
            export: { tag: 'workspace', source: '/workspace', target: '/workspace', mode: 'rw' },
            socketPath: '/unused.sock',
            logPath: '/virtiofs.log',
            evidencePath: '/virtiofs-confinement.json',
          }],
          confinementEvidence: undefined,
        });
      }

      expect(deps.resolveIdentity).toHaveBeenCalledTimes(1);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(directory)).uid).toBe(identity.uid);
      expect((await fs.stat(directory)).gid).toBe(identity.gid);
      const files = await fs.readdir(directory);
      expect(files).toEqual(expect.arrayContaining([
        'guest-stdout.raw.log', 'guest-stderr.raw.log',
      ]));
      if (collection === 'full diagnostics') {
        expect(files).toEqual(expect.arrayContaining([
          'launcher-stdout.log', 'launcher-stderr.log', 'cloud-hypervisor.log',
          'serial.log', 'virtiofs-0-workspace.log', 'virtiofs-0-workspace-confinement.json',
          'network-plan.json', 'network-diagnostics.txt', 'counters.json',
          'vm-info.json', 'runtime.json', 'confinement.json',
        ]));
      }
      for (const file of files) {
        const destination = path.join(directory, file);
        expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
        expect((await fs.stat(destination)).uid).toBe(identity.uid);
        expect((await fs.stat(destination)).gid).toBe(identity.gid);
      }
    },
  );

  it('makes the diagnostic root runner-owned when a boot-attempt directory is created first', async () => {
    const root = path.join(scratch, 'cloud-hypervisor');
    const directory = path.join(root, 'boot-attempt-1');
    const deps = dependencies({
      mkdir: fs.mkdir,
      open: fs.open,
      lstat: fs.lstat,
      realpath: fs.realpath,
      writeFile: fs.writeFile,
      resolveIdentity: jest.fn().mockReturnValue({
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    });
    const capture = new BoundedOutputCapture(1024);
    await writeGuestOutputAudit(directory, deps, capture, capture);
    expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(root)).uid).toBe(process.getuid!());
    expect((await fs.stat(directory)).uid).toBe(process.getuid!());
  });

  it('propagates ownership repair failure instead of reporting a successful handoff', async () => {
    const ownershipError = Object.assign(new Error('ownership denied'), { code: 'EPERM' });
    const deps = dependencies({
      open: jest.fn(async (...args: Parameters<typeof fs.open>) => {
        const handle = await fs.open(...args);
        handle.chown = jest.fn().mockRejectedValue(ownershipError);
        return handle;
      }),
    });
    const capture = new BoundedOutputCapture(1024);
    await expect(writeGuestOutputAudit(scratch, deps, capture, capture))
      .rejects.toThrow('ownership denied');
  });

  it('hands off startup evidence with private modes and a runner-owned diagnostic root', async () => {
    const evidence = path.join(scratch, 'evidence.json');
    await fs.writeFile(evidence, '{}', { mode: 0o644 });
    const root = path.join(scratch, 'cloud-hypervisor');
    const directory = path.join(root, 'startup-run');
    const deps = dependencies({
      mkdir: fs.mkdir,
      open: fs.open,
      lstat: fs.lstat,
      realpath: fs.realpath,
      copyFile: fs.copyFile,
      resolveIdentity: jest.fn().mockReturnValue({
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    });
    await preserveVirtiofsdStartupEvidence(deps, [{
      export: { tag: 'workspace', source: '/workspace', target: '/workspace', mode: 'rw' },
      socketPath: '/unused.sock',
      logPath: '/unused.log',
      evidencePath: evidence,
    }], directory);
    const destination = path.join(directory, 'evidence.json');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(destination)).uid).toBe(process.getuid!());
    expect((await fs.stat(destination)).gid).toBe(process.getgid!());
  });

  it('rejects a symlinked diagnostic directory before changing its target', async () => {
    const target = path.join(scratch, 'target');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, path.join(scratch, 'cloud-hypervisor'));
    const deps = dependencies({
      open: fs.open,
      lstat: fs.lstat,
      realpath: fs.realpath,
    });
    const capture = new BoundedOutputCapture(1024);
    await expect(writeGuestOutputAudit(path.join(scratch, 'cloud-hypervisor'), deps, capture, capture))
      .rejects.toThrow('Refusing to use non-directory path');
    expect((await fs.stat(target)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('rejects a symlinked diagnostics parent before creating a child in its target', async () => {
    const target = path.join(scratch, 'target');
    const audit = path.join(scratch, 'audit');
    await fs.mkdir(target, { mode: 0o700 });
    await fs.mkdir(audit);
    await fs.symlink(target, path.join(audit, 'diagnostics'));
    const deps = dependencies({
      mkdir: fs.mkdir,
      open: fs.open,
      lstat: fs.lstat,
      realpath: fs.realpath,
    });
    const capture = new BoundedOutputCapture(1024);
    const directory = path.join(audit, 'diagnostics', 'cloud-hypervisor', 'boot-attempt-1');
    await expect(writeGuestOutputAudit(directory, deps, capture, capture))
      .rejects.toThrow('Refusing to use non-directory path component');
    expect(await fs.readdir(target)).toEqual([]);
  });

  it('does not overwrite a symlink target when writing a diagnostic file', async () => {
    const directory = path.join(scratch, 'cloud-hypervisor');
    const target = path.join(scratch, 'outside.log');
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.writeFile(target, 'preserve me', { mode: 0o600 });
    await fs.symlink(target, path.join(directory, 'guest-stdout.raw.log'));
    const deps = dependencies({
      mkdir: fs.mkdir,
      open: fs.open,
      lstat: fs.lstat,
      realpath: fs.realpath,
      resolveIdentity: jest.fn().mockReturnValue({
        uid: process.getuid!(),
        gid: process.getgid!(),
      }),
    });
    const capture = new BoundedOutputCapture(1024);
    capture.append('replacement');
    await expect(writeGuestOutputAudit(directory, deps, capture, capture)).rejects.toMatchObject({
      code: 'ELOOP',
    });
    expect(await fs.readFile(target, 'utf8')).toBe('preserve me');
  });

  it.each(['regular', 'file-symlink', 'directory-symlink', 'hardlink'] as const)(
    'protects public session retention destinations (%s)', async (kind) => {
      const protectedRoot = path.join(scratch, 'protected');
      const directory = path.join(protectedRoot, 'invocation');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const target = path.join(scratch, 'outside.log');
      const destination = path.join(directory, 'enclave-session.log');
      await fs.writeFile(target, 'preserve me', { mode: 0o600 });
      if (kind === 'file-symlink') await fs.symlink(target, destination);
      if (kind === 'hardlink') await fs.link(target, destination);
      if (kind === 'directory-symlink') {
        await fs.rename(directory, path.join(scratch, 'moved'));
        await fs.symlink(path.join(scratch, 'moved'), directory);
      }
      const chown = jest.fn().mockResolvedValue(undefined);
      const deps = dependencies({
        mkdir: fs.mkdir,
        lstat: fs.lstat,
        realpath: fs.realpath,
        open: async (...args: Parameters<typeof fs.open>) => {
          const handle = await fs.open(...args);
          handle.chown = chown;
          return handle;
        },
      });
      const secret = 'invocation-capability-secret';
      const result = preservePublicEnclaveSession(directory, protectedRoot, [
        'PUBLIC_ENGINE_ERROR',
        `Authorization: Bearer ${secret}`,
        `{"credential":"${secret}","message":"copilot exited"}`,
        'github_pat_example123 sk-example123',
        'x'.repeat(1024 * 1024),
      ].join('\n'), [secret], deps);
      if (kind !== 'regular') {
        await expect(result).rejects.toThrow();
        expect(await fs.readFile(target, 'utf8')).toBe('preserve me');
        return;
      }
      await result;
      const text = await fs.readFile(destination, 'utf8');
      expect(text).toContain('PUBLIC_ENGINE_ERROR');
      expect(text).toContain('copilot exited');
      expect(text).not.toMatch(/invocation-capability-secret|github_pat_example123|sk-example123/);
      expect((await fs.stat(destination)).size).toBe(1024 * 1024);
      expect((await fs.stat(destination)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
      expect(chown.mock.calls.every(([uid, gid]) => uid === 0 && gid === 0)).toBe(true);
    },
  );
});
