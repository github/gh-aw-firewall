import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getHostCapabilityBoundingSet,
  isCapDropSkipped,
  filterCapDrop,
  filterComposeCapDrop,
  LINUX_CAPABILITY_MAP,
} from './capability-filter';
import { DockerComposeConfig } from './types';
import { generateDockerCompose } from './compose-generator';
import { WrapperConfig } from './types';

describe('capability-filter', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AWF_SKIP_CAP_DROP;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('LINUX_CAPABILITY_MAP', () => {
    it('maps standard Linux capabilities correctly', () => {
      expect(LINUX_CAPABILITY_MAP.NET_RAW).toBe(13);
      expect(LINUX_CAPABILITY_MAP.SYS_MODULE).toBe(16);
      expect(LINUX_CAPABILITY_MAP.SYS_ADMIN).toBe(21);
      expect(LINUX_CAPABILITY_MAP.SYS_BOOT).toBe(22);
    });
  });

  describe('isCapDropSkipped', () => {
    it('returns false when AWF_SKIP_CAP_DROP is unset', () => {
      expect(isCapDropSkipped()).toBe(false);
    });

    it('returns true when AWF_SKIP_CAP_DROP is set to truthy values', () => {
      for (const val of ['1', 'true', 'yes', 'TRUE', 'YES']) {
        process.env.AWF_SKIP_CAP_DROP = val;
        expect(isCapDropSkipped()).toBe(true);
      }
    });

    it('returns false when AWF_SKIP_CAP_DROP is set to non-truthy values', () => {
      for (const val of ['0', 'false', 'no']) {
        process.env.AWF_SKIP_CAP_DROP = val;
        expect(isCapDropSkipped()).toBe(false);
      }
    });
  });

  describe('getHostCapabilityBoundingSet', () => {
    it('returns null when the daemon probe is unavailable', () => {
      expect(getHostCapabilityBoundingSet('/nonexistent:latest')).toBeNull();
    });

    it('does not read the CLI process status', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-test-'));
      const procFile = path.join(tmpDir, 'status');
      try {
        fs.writeFileSync(procFile, 'Name:\tbash\nCapBnd:\t000001ffffffffff\nCapEff:\t0000000000000000\n');
        expect(getHostCapabilityBoundingSet(procFile)).toBeNull();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('filterCapDrop', () => {
    it('returns empty array when input is empty or undefined', () => {
      expect(filterCapDrop(undefined)).toEqual([]);
      expect(filterCapDrop([])).toEqual([]);
    });

    it('returns empty array when AWF_SKIP_CAP_DROP is set', () => {
      process.env.AWF_SKIP_CAP_DROP = '1';
      expect(filterCapDrop(['NET_RAW', 'SYS_MODULE'])).toEqual([]);
    });

    it('returns unmodified list when capBnd is null', () => {
      const list = ['NET_RAW', 'SYS_MODULE', 'SYS_ADMIN'];
      expect(filterCapDrop(list, null)).toEqual(list);
    });

    it('retains capabilities present in CapBnd and filters out missing ones', () => {
      // Full CapBnd (all 41 bits set)
      const fullCapBnd = 0x000001ffffffffffn;
      const list = ['NET_RAW', 'SYS_MODULE', 'SYS_ADMIN', 'MKNOD'];
      expect(filterCapDrop(list, fullCapBnd)).toEqual(list);

      // Trimmed CapBnd: bit 16 (SYS_MODULE) cleared
      const sysModuleBit = 1n << 16n;
      const trimmedCapBnd = fullCapBnd & ~sysModuleBit;

      expect(filterCapDrop(list, trimmedCapBnd)).toEqual(['NET_RAW', 'SYS_ADMIN', 'MKNOD']);
    });

    it('handles CAP_ prefix and case insensitivity', () => {
      const fullCapBnd = 0x000001ffffffffffn;
      const sysModuleBit = 1n << 16n;
      const trimmedCapBnd = fullCapBnd & ~sysModuleBit;

      const list = ['CAP_NET_RAW', 'cap_sys_module', 'CAP_SYS_ADMIN'];
      expect(filterCapDrop(list, trimmedCapBnd)).toEqual(['CAP_NET_RAW', 'CAP_SYS_ADMIN']);
    });

    it('preserves ALL wildcard', () => {
      const trimmedCapBnd = 0n;
      expect(filterCapDrop(['ALL'], trimmedCapBnd)).toEqual(['ALL']);
    });

    it('preserves unknown capability names', () => {
      const trimmedCapBnd = 0n;
      expect(filterCapDrop(['UNKNOWN_CUSTOM_CAP'], trimmedCapBnd)).toEqual(['UNKNOWN_CUSTOM_CAP']);
    });
  });

  describe('filterComposeCapDrop', () => {
    it('filters cap_drop across all services in compose config', () => {
      const compose = {
        version: '3.8',
        networks: {},
        services: {
          'squid-proxy': {
            container_name: 'awf-squid',
            cap_drop: ['NET_RAW', 'SYS_ADMIN', 'SYS_MODULE'],
          },
          agent: {
            container_name: 'awf-agent',
            cap_drop: ['NET_RAW', 'SYS_MODULE'],
          },
          'api-proxy': {
            container_name: 'awf-api-proxy',
            cap_drop: ['ALL'],
          },
        },
      } as unknown as DockerComposeConfig;

      // Trim SYS_MODULE (bit 16)
      const fullCapBnd = 0x000001ffffffffffn;
      const sysModuleBit = 1n << 16n;
      const trimmedCapBnd = fullCapBnd & ~sysModuleBit;

      const filtered = filterComposeCapDrop(compose, trimmedCapBnd);
      expect(filtered.services['squid-proxy'].cap_drop).toEqual(['NET_RAW', 'SYS_ADMIN']);
      expect(filtered.services.agent.cap_drop).toEqual(['NET_RAW']);
      expect(filtered.services['api-proxy'].cap_drop).toEqual(['ALL']);
    });

    it('deletes cap_drop key if all capabilities are filtered out', () => {
      const compose = {
        version: '3.8',
        networks: {},
        services: {
          agent: {
            container_name: 'awf-agent',
            cap_drop: ['SYS_MODULE'],
          },
        },
      } as unknown as DockerComposeConfig;

      // Trim SYS_MODULE (bit 16)
      const fullCapBnd = 0x000001ffffffffffn;
      const sysModuleBit = 1n << 16n;
      const trimmedCapBnd = fullCapBnd & ~sysModuleBit;

      const filtered = filterComposeCapDrop(compose, trimmedCapBnd);
      expect(filtered.services.agent.cap_drop).toBeUndefined();
    });

    it('deletes cap_drop from all services when AWF_SKIP_CAP_DROP is set', () => {
      process.env.AWF_SKIP_CAP_DROP = 'true';
      const compose = {
        version: '3.8',
        networks: {},
        services: {
          'squid-proxy': {
            container_name: 'awf-squid',
            cap_drop: ['NET_RAW', 'SYS_ADMIN', 'SYS_MODULE'],
          },
          agent: {
            container_name: 'awf-agent',
            cap_drop: ['NET_RAW', 'SYS_MODULE'],
          },
          'api-proxy': {
            container_name: 'awf-api-proxy',
            cap_drop: ['ALL'],
          },
        },
      } as unknown as DockerComposeConfig;

      const filtered = filterComposeCapDrop(compose);
      expect(filtered.services['squid-proxy'].cap_drop).toBeUndefined();
      expect(filtered.services.agent.cap_drop).toBeUndefined();
      expect(filtered.services['api-proxy'].cap_drop).toBeUndefined();
    });
  });

  describe('integration with generateDockerCompose', () => {
    it('removes cap_drop from generated compose when AWF_SKIP_CAP_DROP is set', () => {
      process.env.AWF_SKIP_CAP_DROP = '1';
      const tmpWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-cap-test-'));
      try {
        const mockConfig: WrapperConfig = {
          allowedDomains: ['github.com'],
          agentCommand: 'echo test',
          logLevel: 'info',
          keepContainers: false,
          workDir: tmpWorkDir,
          buildLocal: false,
          imageRegistry: 'ghcr.io/github/gh-aw-firewall',
          imageTag: 'latest',
        };
        const mockNetworkConfig = {
          subnet: '172.30.0.0/24',
          squidIp: '172.30.0.10',
          agentIp: '172.30.0.20',
        };

        const result = generateDockerCompose(mockConfig, mockNetworkConfig);
        for (const service of Object.values(result.services)) {
          expect(service.cap_drop).toBeUndefined();
        }
      } finally {
        fs.rmSync(tmpWorkDir, { recursive: true, force: true });
      }
    });
  });
});
