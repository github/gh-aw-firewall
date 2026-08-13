import { createHash } from 'crypto';
import { createReadStream, promises as fs } from 'fs';
import { isIP } from 'net';
import * as path from 'path';

export interface MicrovmRootfsConfig {
  readonly runDirectory: string;
  readonly baseRootfsPath: string;
  readonly supervisorBinaryPath: string;
  readonly supervisorSha256: string;
  readonly supervisorGuestPath?: string;
  readonly hostAliases?: Readonly<Record<string, string>>;
}

export interface MicrovmRootfsDependencies {
  runTool(command: string, args: readonly string[]): Promise<void>;
}

export class MicrovmRootfsPreparer {
  readonly rootfsImagePath: string;

  constructor(
    private readonly config: MicrovmRootfsConfig,
    private readonly dependencies: MicrovmRootfsDependencies,
  ) {
    this.rootfsImagePath = path.join(config.runDirectory, 'rootfs.ext4');
  }

  async prepare(): Promise<string> {
    await assertRegularFile(this.config.baseRootfsPath, 'microVM base rootfs');
    await assertRegularFile(this.config.supervisorBinaryPath, 'guest supervisor');
    if (!/^[A-Fa-f0-9]{64}$/.test(this.config.supervisorSha256)) {
      throw new Error('guest supervisor SHA-256 must be 64 hexadecimal characters');
    }
    const actual = await sha256File(this.config.supervisorBinaryPath);
    if (actual !== this.config.supervisorSha256.toLowerCase()) {
      throw new Error(
        `guest supervisor SHA-256 mismatch: expected ${
          this.config.supervisorSha256.toLowerCase()
        }, got ${actual}`,
      );
    }
    await fs.mkdir(this.config.runDirectory, { recursive: true, mode: 0o700 });
    await fs.copyFile(this.config.baseRootfsPath, this.rootfsImagePath);
    const localSupervisor = path.join(this.config.runDirectory, 'awf-supervisor');
    const guestSupervisor = this.config.supervisorGuestPath ?? '/sbin/awf-supervisor';
    await fs.copyFile(this.config.supervisorBinaryPath, localSupervisor);
    await fs.chmod(localSupervisor, 0o500);
    assertDebugfsOperand(localSupervisor, 'supervisor staging path');
    assertDebugfsOperand(guestSupervisor, 'supervisor guest path');
    if (!guestSupervisor.startsWith('/')) {
      throw new Error(`microVM supervisor guest path must be absolute: ${guestSupervisor}`);
    }
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', `rm ${guestSupervisor}`, this.rootfsImagePath,
    ]);
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', `write ${localSupervisor} ${guestSupervisor}`, this.rootfsImagePath,
    ]);
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', `sif ${guestSupervisor} mode 0100755`, this.rootfsImagePath,
    ]);
    await this.injectHostAliases();
    await this.dependencies.runTool('e2fsck', ['-f', '-y', this.rootfsImagePath]);
    return this.rootfsImagePath;
  }

  private async injectHostAliases(): Promise<void> {
    const aliases = Object.entries(this.config.hostAliases ?? {});
    if (aliases.length === 0) return;

    const lines = ['127.0.0.1 localhost', '::1 localhost ip6-localhost ip6-loopback'];
    for (const [host, address] of aliases) {
      if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/i.test(host) || !isIP(address)) {
        throw new Error(`Invalid microVM host alias: ${host}=${address}`);
      }
      lines.push(`${address} ${host}`);
    }

    const localHosts = path.join(this.config.runDirectory, 'hosts');
    await fs.writeFile(localHosts, `${lines.join('\n')}\n`, { mode: 0o600 });
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', 'rm /etc/hosts', this.rootfsImagePath,
    ]);
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', `write ${localHosts} /etc/hosts`, this.rootfsImagePath,
    ]);
    await this.dependencies.runTool('debugfs', [
      '-w', '-R', 'sif /etc/hosts mode 0100644', this.rootfsImagePath,
    ]);
  }
}

function assertDebugfsOperand(value: string, label: string): void {
  if (/[\s"'\\;`\0]/.test(value)) throw new Error(`Unsafe ${label}`);
}

async function assertRegularFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file: ${filePath}`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
