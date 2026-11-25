import { promises as fs } from 'fs';
import * as path from 'path';
import type { NvxCgroupLimits } from './confinement';

const CGROUP_V2_CONTROLLERS = '+cpu +memory +pids';

export interface NvxCgroupDependencies {
  mkdir(directory: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  writeFile(filePath: string, contents: string): Promise<void>;
  readFile(filePath: string, encoding: 'utf8'): Promise<string>;
  rmdir(directory: string): Promise<void>;
}

export class NvxCgroupManager {
  private created = false;

  constructor(
    readonly cgroupPath: string,
    private readonly limits: NvxCgroupLimits,
    private readonly dependencies: NvxCgroupDependencies = {
      mkdir: (directory, options) => fs.mkdir(directory, options),
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      rmdir: fs.rmdir,
    },
  ) {}

  async setup(): Promise<void> {
    const parentDir = path.dirname(this.cgroupPath);
    const rootDir = path.dirname(parentDir);
    if (rootDir !== '/sys/fs/cgroup') {
      throw new Error(`NVX cgroup path must be /sys/fs/cgroup/<parent>/<run>: ${this.cgroupPath}`);
    }
    await this.dependencies.writeFile(path.join(rootDir, 'cgroup.subtree_control'), CGROUP_V2_CONTROLLERS);
    await this.dependencies.mkdir(parentDir, { recursive: true, mode: 0o700 });
    await this.dependencies.writeFile(path.join(parentDir, 'cgroup.subtree_control'), CGROUP_V2_CONTROLLERS);
    await this.dependencies.mkdir(this.cgroupPath, { mode: 0o700 });
    this.created = true;
    await this.writeAndVerifyLimit('memory.max', this.limits.memoryMax);
    await this.writeAndVerifyLimit('cpu.max', this.limits.cpuMax);
    await this.writeAndVerifyLimit('pids.max', this.limits.pidsMax);
  }

  async assignProcessTree(pids: readonly number[]): Promise<void> {
    const unique = [...new Set(pids)];
    if (unique.length < 1 || unique.some((pid) => !Number.isSafeInteger(pid) || pid <= 0)) {
      throw new Error('NVX cgroup assignment requires positive process IDs');
    }
    for (const pid of unique) {
      await this.dependencies.writeFile(path.join(this.cgroupPath, 'cgroup.procs'), String(pid));
    }
    const observed = parseNumericLines(
      await this.dependencies.readFile(path.join(this.cgroupPath, 'cgroup.procs'), 'utf8'),
    );
    if (observed.join(',') !== unique.sort((a, b) => a - b).join(',')) {
      throw new Error(`NVX cgroup membership mismatch: ${observed.join(',')}`);
    }
  }

  async cleanup(): Promise<void> {
    if (!this.created) return;
    const members = parseNumericLines(
      await this.dependencies.readFile(path.join(this.cgroupPath, 'cgroup.procs'), 'utf8'),
    );
    if (members.length > 0) {
      throw new Error(`Refusing to remove non-empty NVX cgroup: ${members.join(',')}`);
    }
    await this.dependencies.rmdir(this.cgroupPath);
    this.created = false;
  }

  private async writeAndVerifyLimit(fileName: string, value: string): Promise<void> {
    const filePath = path.join(this.cgroupPath, fileName);
    await this.dependencies.writeFile(filePath, value);
    const observed = (await this.dependencies.readFile(filePath, 'utf8')).trim();
    if (observed !== value) throw new Error(`NVX cgroup ${fileName} mismatch: ${observed}`);
  }
}

function parseNumericLines(contents: string): number[] {
  return contents.split('\n').filter(Boolean).map((value) => {
    if (!/^\d+$/.test(value)) throw new Error(`NVX cgroup PID is malformed: ${value}`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`NVX cgroup PID is unsafe: ${value}`);
    return parsed;
  }).sort((a, b) => a - b);
}
