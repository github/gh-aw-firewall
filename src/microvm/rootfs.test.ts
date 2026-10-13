import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MicrovmRootfsPreparer } from './rootfs';

describe('microVM per-run rootfs preparation', () => {
  it.each([undefined, 96, 2048])('preserves pinned source artifacts with optional scratch init %s', async (scratchMib) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-rootfs-scratch-'));
    try {
      const baseRootfsPath = path.join(root, 'released.ext4');
      const supervisorBinaryPath = path.join(root, 'released-supervisor');
      const runDirectory = path.join(root, 'run');
      await fs.writeFile(baseRootfsPath, 'pinned-rootfs');
      await fs.writeFile(supervisorBinaryPath, 'pinned-supervisor');
      const commands: string[][] = [];
      const preparer = new MicrovmRootfsPreparer({
        runDirectory, baseRootfsPath, supervisorBinaryPath, scratchMib,
        supervisorSha256: createHash('sha256').update('pinned-supervisor').digest('hex'),
        supervisorGuestPath: '/usr/sbin/awf-supervisor',
      }, {
        copyRootfs: fs.copyFile,
        runTool: async (command, args) => { commands.push([command, ...args]); },
      });
      await preparer.prepare();
      expect(await fs.readFile(baseRootfsPath, 'utf8')).toBe('pinned-rootfs');
      expect(await fs.readFile(supervisorBinaryPath, 'utf8')).toBe('pinned-supervisor');
      expect(await fs.readFile(path.join(runDirectory, 'awf-supervisor'), 'utf8')).toBe('pinned-supervisor');
      const initCommands = commands.filter((args) => args.join(' ').includes('awf-scratch-init'));
      if (scratchMib === undefined) {
        expect(initCommands).toEqual([]);
      } else {
        expect(initCommands).toEqual([
          ['debugfs', '-w', '-R', 'rm /usr/sbin/awf-scratch-init', preparer.rootfsImagePath],
          ['debugfs', '-w', '-R', `write ${runDirectory}/awf-scratch-init /usr/sbin/awf-scratch-init`, preparer.rootfsImagePath],
          ['debugfs', '-w', '-R', 'sif /usr/sbin/awf-scratch-init mode 0100755', preparer.rootfsImagePath],
        ]);
        const script = await fs.readFile(path.join(runDirectory, 'awf-scratch-init'), 'utf8');
        expect(script).toContain(`size=${scratchMib * 1024 * 1024},mode=1777,nosuid,nodev`);
        expect(script).toContain("exec '/usr/sbin/awf-supervisor'");
      }
      expect(commands[commands.length - 1]?.[0]).toBe('e2fsck');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
