import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import execa from 'execa';
import {
  assertBoundedEnclaveWritableExports,
  mountBoundedEnclaveStorage,
  unmountBoundedEnclaveStorage,
} from './enclave-storage';
import { CLOUD_HYPERVISOR_ENCLAVE_RESOURCE_PROFILES as profiles } from './workload-profile';
import type { CloudHypervisorDirectoryExport } from './exports';
import { CloudHypervisorCgroup } from './launcher';

const live = process.env.AWF_TEST_ENCLAVE_STORAGE === '1';
const tools = { mount: '/usr/bin/mount', umount: '/usr/bin/umount' };
const page = Buffer.alloc(4096, 1);

// Exercise the host sources served by the closed guest-visible virtio-fs
// exports. Live VM transport conformance is gated separately on KVM artifacts.
(live ? describe : describe.skip)('host-enforced enclave storage', () => {
  let root: string;
  const mounted = new Set<string>();

  beforeAll(async () => {
    if (process.getuid?.() !== 0) throw new Error('AWF_TEST_ENCLAVE_STORAGE requires root and mount privileges');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-storage-'));
  });

  afterEach(async () => {
    for (const directory of [...mounted].reverse()) {
      await unmountBoundedEnclaveStorage(directory, tools);
      mounted.delete(directory);
    }
    await fs.rm(root, { recursive: true, force: true });
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-storage-'));
  });

  afterAll(async () => {
    expect(mounted.size).toBe(0);
    await fs.rm(root, { recursive: true, force: true });
  });

  async function provision(role: 'script' | 'agent', name: string) {
    const directory = path.join(root, name);
    await fs.mkdir(directory, { mode: 0o700 });
    const profile = profiles[role];
    await mountBoundedEnclaveStorage(
      directory, profile.writableStorageBytes, profile.uid, profile.gid, tools,
    );
    mounted.add(directory);
    const names = ['output', 'runtime', ...(role === 'agent' ? ['session-state'] : [])];
    const exports: CloudHypervisorDirectoryExport[] = [];
    for (const name of names) {
      const source = path.join(directory, name);
      await fs.mkdir(source, { mode: 0o700 });
      exports.push({ tag: `enclave-${name}`, source, target: `/${name}`, mode: 'rw' });
    }
    await assertBoundedEnclaveWritableExports(exports, profile.writableStorageBytes);
    return { directory, exports, size: profile.writableStorageBytes };
  }

  it.each(['script', 'agent'] as const)(
    '%s writes exhaust one aggregate budget across sparse and concurrent exports',
    async (role) => {
      const { exports, size } = await provision(role, role);
      const files = await Promise.all(exports.map(({ source }) => fs.open(path.join(source, 'sparse'), 'wx')));
      try {
        // Logical holes are not allocated storage. Writes into them must still
        // consume the same page budget, even far beyond the capacity offset.
        await Promise.all(files.map((file) => file.truncate(size * 4)));
        const chunk = Buffer.alloc(1024 * 1024, 1);
        const pagesPerChunk = chunk.length / page.length;
        const chunksPerFile = Math.floor(size / chunk.length / files.length);
        await Promise.all(files.map(async (file) => {
          for (let chunkIndex = 0; chunkIndex < chunksPerFile; chunkIndex += 1) {
            await file.write(chunk, 0, chunk.length, size * 2 + chunkIndex * chunk.length);
          }
        }));
        const allocated = chunksPerFile * files.length * chunk.length;
        const remainingPages = (size - allocated) / page.length;
        for (let index = 0; index < remainingPages; index += 1) {
          await files[0].write(page, 0, page.length,
            size * 2 + (chunksPerFile * pagesPerChunk + index) * page.length);
        }
        const attempts = await Promise.all(files.map((file) => file.write(page, 0, page.length, 0)
          .then(() => 'unexpected success', (error: NodeJS.ErrnoException) => error.code)));
        expect(attempts).toEqual(files.map(() => 'ENOSPC'));
        const stats = await Promise.all(files.map((file) => file.stat()));
        expect(stats.reduce((total, stat) => total + stat.blocks * 512, 0)).toBe(size);
      } finally {
        await Promise.all(files.map((file) => file.close()));
      }
    }, 120_000,
  );

  it('isolates invocations and rejects an export redirected through another mount', async () => {
    const first = await provision('agent', 'first');
    const second = await provision('agent', 'second');
    await fs.writeFile(path.join(first.exports[0].source, 'private'), 'first');
    await expect(fs.readFile(path.join(second.exports[0].source, 'private'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.stat(first.directory)).dev).not.toBe((await fs.stat(second.directory)).dev);
    const escaped = path.join(first.directory, 'escape');
    await fs.symlink(second.exports[0].source, escaped);
    await expect(assertBoundedEnclaveWritableExports([
      { ...first.exports[0], source: escaped },
    ], first.size)).rejects.toThrow(/escapes/);

    const nested = first.exports[1].source;
    await execa(tools.mount, ['--bind', second.exports[1].source, nested]);
    mounted.add(nested);
    await expect(assertBoundedEnclaveWritableExports(first.exports, first.size))
      .rejects.toThrow(/unverifiable/);
  });

  it.each(['script', 'agent'] as const)('reaches %s ENOSPC with resident guest RAM in the host memory cgroup', async (role) => {
    const { exports, size } = await provision(role, `cgroup-${role}`);
    const profile = profiles[role];
    const cgroup = new CloudHypervisorCgroup(
      `/sys/fs/cgroup/awf-cloud-hypervisor/storage-${path.basename(root)}`,
      {
        memoryMib: profile.memoryMiB, vcpuCount: profile.vcpuCount,
        cpuQuotaMilli: profile.cpuQuotaMilli, writableStorageBytes: size,
      },
    );
    await cgroup.setup();
    await fs.writeFile(path.join(cgroup.cgroupPath, 'memory.swap.max'), '0');
    // A separate process holds the guest-RAM equivalent resident while filling
    // tmpfs. Both charges must fit the same production host memory budget.
    const writer = execa(process.execPath, ['-e', `
      const fs = require('fs');
      const { sources, size, memory } = JSON.parse(process.argv[1]);
      process.stdin.once('data', () => {
        const guestRam = Buffer.alloc(memory, 1);
        const chunk = Buffer.alloc(1024 * 1024, 1);
        const files = sources.map(source => fs.openSync(source + '/charged', 'wx'));
        try {
          for (let index = 0; index < size / chunk.length; index++) {
            fs.writeSync(files[index % files.length], chunk, 0, chunk.length,
              Math.floor(index / files.length) * chunk.length);
          }
          for (const file of files) {
            try {
              fs.writeSync(file, chunk, 0, 4096, size);
              throw new Error('storage was not bounded');
            } catch (error) {
              if (error.code !== 'ENOSPC') throw error;
            }
          }
          if (guestRam[guestRam.length - 1] !== 1) throw new Error('guest RAM missing');
          console.log('ENOSPC');
        } finally {
          files.forEach(file => fs.closeSync(file));
        }
      });
    `, JSON.stringify({
      sources: exports.map(({ source }) => source), size, memory: profile.memoryMiB * 1024 * 1024,
    })], { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      if (writer.pid === undefined) throw new Error('storage writer did not start');
      await cgroup.assign(writer.pid);
      writer.stdin!.end('start');
      expect((await writer).stdout.trim()).toBe('ENOSPC');
      expect(await fs.readFile(path.join(cgroup.cgroupPath, 'memory.events'), 'utf8'))
        .toMatch(/^oom_kill 0$/m);
      expect(BigInt((await fs.readFile(path.join(cgroup.cgroupPath, 'memory.peak'), 'utf8')).trim()))
        .toBeGreaterThan(BigInt((profile.memoryMiB + 256) * 1024 * 1024));
    } finally {
      writer.kill('SIGKILL');
      await writer.catch(() => undefined);
      await cgroup.cleanup();
    }
  }, 120_000);

  it('does not report successful cleanup or remove a busy backing store', async () => {
    const { directory, exports } = await provision('agent', 'busy');
    const handle = await fs.open(path.join(exports[0].source, 'open'), 'wx');
    try {
      await expect(unmountBoundedEnclaveStorage(directory, tools)).rejects.toThrow(/unmount/);
      await assertBoundedEnclaveWritableExports(exports, profiles.agent.writableStorageBytes);
    } finally {
      await handle.close();
    }
    await unmountBoundedEnclaveStorage(directory, tools);
    mounted.delete(directory);
    await fs.rm(directory, { recursive: true });
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
