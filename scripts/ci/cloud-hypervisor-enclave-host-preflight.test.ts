import { execFileSync, spawnSync } from 'child_process';
import * as path from 'path';
import {
  ProductionTrustedCloudHypervisorEnclaveStorageProvider,
  type TrustedEnclaveStorageHostDependencies,
} from '../../src/cloud-hypervisor/trusted-enclave-storage';

const probePath = path.join(__dirname, 'cloud-hypervisor-enclave-host-preflight.js');
const probe = require(probePath) as {
  probeHostAdmission(provider: ProductionTrustedCloudHypervisorEnclaveStorageProvider): Promise<{
    schemaVersion: number; perspective: string; status: string; hostPreflight: {
      scope: string; checks: { id: string; result: string; reason: string }[];
    };
  }>;
};

describe('separate executable host admission probe', () => {
  const host: TrustedEnclaveStorageHostDependencies = {
    platform: 'linux', arch: 'x64', uid: 0,
    environment: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', ImageOS: 'ubuntu24' },
    readFile: async (file) => {
      if (file === '/etc/os-release') return 'ID=ubuntu\n';
      if (file === '/proc/self/status') return 'CapEff:\t0000000000200000\n';
      if (file === '/proc/filesystems') return 'nodev\ttmpfs\n';
      return 'cpu memory pids\n';
    },
    access: async () => undefined, lstat: async () => ({ isCharacterDevice: () => true }),
    openKvm: async () => undefined,
  };

  it('uses the actual admission implementation but cannot claim AWF or guest execution', async () => {
    const provider = new ProductionTrustedCloudHypervisorEnclaveStorageProvider(host);
    const prepare = jest.spyOn(provider, 'prepareRun');
    const result = await probe.probeHostAdmission(provider);
    expect(result).toMatchObject({ schemaVersion: 1, perspective: 'preflight-harness', status: 'passed' });
    expect(result.hostPreflight.checks.every((check) => check.result === 'passed')).toBe(true);
    expect(result).not.toHaveProperty('readiness');
    expect(prepare).not.toHaveBeenCalled();
  });

  it('fails explicitly and prints only origin check metadata, never private error content', async () => {
    const result = await probe.probeHostAdmission(new ProductionTrustedCloudHypervisorEnclaveStorageProvider({
      ...host, openKvm: async () => {
        throw Object.assign(new Error('/private/SECRET\nBearer token'), { code: 'EPERM' });
      },
    }));
    expect(result).toMatchObject({ perspective: 'preflight-harness', status: 'failed' });
    expect(result.hostPreflight.checks.find((check) => check.id === 'kvm-open'))
      .toEqual({ id: 'kvm-open', result: 'failed', reason: 'EPERM' });
    expect(result.hostPreflight.checks.find((check) => check.id === 'cgroup-writable')?.result).toBe('not-attempted');
    expect(JSON.stringify(result)).not.toMatch(/private|SECRET|Bearer|token/);
  });

  it('is executable and fails closed on an unsupported local host without a bypass', () => {
    execFileSync(process.execPath, ['--check', probePath]);
    const child = spawnSync(process.execPath, [probePath], {
      encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' },
    });
    expect(child.status).toBe(1);
    expect(child.stderr).toBe('');
    const result = JSON.parse(child.stdout.trim().replace(/^AWF_HOST_PREFLIGHT_PROBE /, ''));
    expect(result).toMatchObject({ perspective: 'preflight-harness', status: 'failed' });
    expect(result.hostPreflight.checks.some((check: { result: string }) => check.result === 'failed')).toBe(true);
  });
});
