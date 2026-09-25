import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { WrapperConfig } from '../types';
import {
  assertNvxContainerWorkDirResolvesWithinWorkspace,
  assertNvxHostEligibility,
  assertNvxRuntimeCompatibility,
  assertNvxSelection,
  isPrimaryNvxRuntime,
  requireNvxConfig,
} from './runtime-validation';

function baseNvx() {
  return {
    previewEnabled: true,
    mountPolicy: 'workspace-only' as const,
    layerPath: '/opt/nvx/distro.layer',
    artifactManifestPath: '/opt/nvx/manifest.json',
    artifactManifestBundlePath: '/opt/nvx/manifest.sigstore.jsonl',
    openvmmPath: '/opt/nvx/openvmm',
    kernelPath: '/opt/nvx/kernel',
    initramfsPath: '/opt/nvx/initramfs',
    memoryMib: 512,
    memoryMaxBytes: 512 * 1024 * 1024,
    pidsMax: 128,
  };
}

function config(overrides: Partial<WrapperConfig> = {}): WrapperConfig {
  return {
    containerRuntime: 'nvx',
    networkIsolation: true,
    legacySecurity: false,
    enableApiProxy: true,
    enableDind: false,
    enableHostAccess: false,
    tty: false,
    nvx: baseNvx(),
    ...overrides,
  } as WrapperConfig;
}

const linuxX64 = { platform: 'linux' as const, arch: 'x64' };
const originalPlatform = process.platform;
const originalArch = process.arch;

describe('NVX runtime validation', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    Object.defineProperty(process, 'arch', { value: originalArch });
  });

  it('isPrimaryNvxRuntime is true only when nvx is explicitly selected', () => {
    expect(isPrimaryNvxRuntime(config())).toBe(true);
    expect(isPrimaryNvxRuntime(config({ containerRuntime: 'docker' }))).toBe(false);
    expect(isPrimaryNvxRuntime(config({ containerRuntime: undefined }))).toBe(false);
  });

  describe('assertNvxSelection', () => {
    it('accepts nvx runtime selection paired with nvx config', () => {
      expect(() => assertNvxSelection(config())).not.toThrow();
    });

    it('rejects nvx config without selecting the nvx runtime', () => {
      expect(() => assertNvxSelection(config({ containerRuntime: 'docker' })))
        .toThrow(/require --container-runtime nvx/);
    });

    it('rejects selecting nvx without any nvx configuration', () => {
      expect(() => assertNvxSelection(config({ nvx: undefined })))
        .toThrow(/requires top-level nvx runtime configuration/);
    });
  });

  describe('assertNvxHostEligibility', () => {
    it('accepts a Linux x64 host', () => {
      expect(() => assertNvxHostEligibility(linuxX64)).not.toThrow();
    });

    it('rejects non-Linux hosts', () => {
      expect(() => assertNvxHostEligibility({ platform: 'darwin', arch: 'x64' }))
        .toThrow(/requires a Linux host/);
    });

    it('rejects non-x64 architectures', () => {
      expect(() => assertNvxHostEligibility({ platform: 'linux', arch: 'arm64' }))
        .toThrow(/supports only x86_64 hosts/);
    });
  });

  describe('assertNvxRuntimeCompatibility', () => {
    it('accepts a fully configured, eligible selection', () => {
      expect(() => assertNvxRuntimeCompatibility(config(), baseNvx())).not.toThrow();
    });

    describe('assertNvxContainerWorkDirResolvesWithinWorkspace', () => {
      let root: string;
      let workspace: string;

      beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nvx-workdir-')));
        workspace = path.join(root, 'workspace');
        await fs.mkdir(path.join(workspace, 'packages', 'app'), { recursive: true });
      });

      afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
      });

      it('accepts an existing directory inside the canonical workspace', async () => {
        await expect(assertNvxContainerWorkDirResolvesWithinWorkspace(
          '/workspace/packages/app',
          workspace,
        )).resolves.toBeUndefined();
      });

      it('rejects a workspace symlink that resolves outside the export', async () => {
        const outside = path.join(root, 'outside');
        await fs.mkdir(outside);
        await fs.symlink(outside, path.join(workspace, 'escaped'));

        await expect(assertNvxContainerWorkDirResolvesWithinWorkspace(
          '/workspace/escaped',
          workspace,
        )).rejects.toThrow(/resolves outside the guest workspace export/);
      });

      it('reports a missing workdir as an NVX container-workdir error', async () => {
        await expect(assertNvxContainerWorkDirResolvesWithinWorkspace(
          '/workspace/missing',
          workspace,
        )).rejects.toThrow(/--container-workdir does not exist in the workspace export/);
      });
    });

    it('rejects when the preview flag is not enabled', () => {
      expect(() => assertNvxRuntimeCompatibility(config({
        nvx: { ...baseNvx(), previewEnabled: false },
      }))).toThrow(/explicit --nvx-preview opt-in/);
    });

    it('rejects without strict network isolation', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ networkIsolation: false })))
        .toThrow(/strict --network-isolation/);
      expect(() => assertNvxRuntimeCompatibility(config({ legacySecurity: true })))
        .toThrow(/strict --network-isolation/);
    });

    it('rejects without API proxy credential isolation', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ enableApiProxy: false })))
        .toThrow(/API proxy credential isolation/);
    });

    it('rejects TTY execution', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ tty: true })))
        .toThrow(/does not support --tty/);
    });

    it('rejects Docker-in-Docker and split-filesystem configurations', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ enableDind: true })))
        .toThrow(/Docker-in-Docker or split filesystems/);
      expect(() => assertNvxRuntimeCompatibility(config({ dockerHostPathPrefix: '/host' })))
        .toThrow(/Docker-in-Docker or split filesystems/);
      expect(() => assertNvxRuntimeCompatibility(config({ runnerTopology: 'arc-dind' })))
        .toThrow(/Docker-in-Docker or split filesystems/);
    });

    it('rejects host access, extra volume mounts, DIFC proxy, and DNS-over-HTTPS', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ enableHostAccess: true })))
        .toThrow(/does not support host access/);
      expect(() => assertNvxRuntimeCompatibility(config({ volumeMounts: ['/tmp:/tmp'] })))
        .toThrow(/additional host volume mounts/);
      expect(() => assertNvxRuntimeCompatibility(config({ difcProxyHost: '127.0.0.1' })))
        .toThrow(/does not yet support DIFC proxies/);
      expect(() => assertNvxRuntimeCompatibility(config({ dnsOverHttps: 'https://example.com/dns-query' })))
        .toThrow(/does not support DNS-over-HTTPS/);
    });

    it('rejects a relocated network subnet', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ networkSubnet: '10.99.0.0/24' })))
        .toThrow(/does not support --network-subnet/);
    });

    it('accepts a container working directory inside the live workspace export', () => {
      expect(() => assertNvxRuntimeCompatibility(
        config({ containerWorkDir: '/workspace/packages/app' }),
      )).not.toThrow();
    });

    it('rejects a container working directory outside the live workspace export', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ containerWorkDir: '/repo' })))
        .toThrow(/must be inside the guest workspace export/);
    });

    it('rejects a relative container working directory', () => {
      expect(() => assertNvxRuntimeCompatibility(config({ containerWorkDir: 'repo' })))
        .toThrow(/requires an absolute --container-workdir/);
    });

    it('rejects an unsupported mount policy', () => {
      expect(() => assertNvxRuntimeCompatibility(config({
        nvx: { ...baseNvx(), mountPolicy: 'everything' as never },
      }))).toThrow(/mount policy must be/);
    });

    it('rejects primary-agent execution with enclaves enabled, without any fallback', () => {
      expect(() => assertNvxRuntimeCompatibility(config({
        enclaves: { enabled: true } as WrapperConfig['enclaves'],
      }))).toThrow(/no runtime fallback is permitted/);
    });

    it('rejects incomplete artifact configuration', () => {
      expect(() => assertNvxRuntimeCompatibility(config({
        nvx: { ...baseNvx(), layerPath: undefined },
      }))).toThrow(/explicit guest distro layer/);
      expect(() => assertNvxRuntimeCompatibility(config({
        nvx: { ...baseNvx(), kernelPath: undefined },
      }))).toThrow(/OpenVMM, kernel, and initramfs artifact paths/);
      expect(() => assertNvxRuntimeCompatibility(config({
        nvx: { ...baseNvx(), artifactManifestPath: undefined },
      }))).toThrow(/artifact manifest and attestation bundle/);
    });

    it('rejects on an ineligible host even when configuration is otherwise valid', () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        expect(() => assertNvxRuntimeCompatibility(config())).toThrow(/requires a Linux host/);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform });
      }
    });
  });

  describe('requireNvxConfig', () => {
    it('returns the nvx config for the primary nvx runtime', () => {
      const valid = config();
      expect(requireNvxConfig(valid)).toBe(valid.nvx);
    });

    it('throws when resolved without nvx runtime configuration', () => {
      expect(() => requireNvxConfig(config({ containerRuntime: 'docker' })))
        .toThrow(/resolved without NVX runtime configuration/);
      expect(() => requireNvxConfig(config({ nvx: undefined })))
        .toThrow(/resolved without NVX runtime configuration/);
    });
  });
});
