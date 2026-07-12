/**
 * Targeted branch-coverage tests for paths missed in the initial coverage run.
 *
 * Targets:
 *  src/commands/signal-handler.ts  line 46: SIGTERM + keepContainers=true (false branch of &&)
 *  src/commands/preflight.ts       line 51: String(error) path for non-Error throws in config load
 *                                  lines 73,82,217: raw non-Error value in template literal
 *  src/compose-generator.ts        line 29: buildLocal + containers dir missing (throw branch)
 *                                  line 84: GITHUB_WORKSPACE unset → process.cwd() fallback
 *                                  line 152: redactDockerComposeSecrets service without environment
 *  src/compose-network.ts          line 37: squidService.networks already set (truthy path of ||)
 */

// ─── signal-handler.ts — SIGTERM with keepContainers=true ────────────────────

import { registerSignalHandlers } from './commands/signal-handler';
import { flushPromises, createSignalHandlerTestHarness } from './commands/signal-handler.test-utils';

describe('registerSignalHandlers — SIGTERM keepContainers=true (line 46 false branch)', () => {
  const harness = createSignalHandlerTestHarness();

  it('skips fast-kill on SIGTERM when keepContainers=true (covers line 46 false branch)', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    registerSignalHandlers({
      getContainersStarted: () => true,
      keepContainers: true,
      fastKillAgentContainer: fastKill,
      performCleanup,
    });

    harness.handlers['SIGTERM']();
    await flushPromises();

    expect(fastKill).not.toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGTERM');
    expect(harness.processExitSpy).toHaveBeenCalledWith(143);
  });

  it('skips fast-kill on SIGTERM when containers not started (covers line 46 false branch)', async () => {
    const fastKill = jest.fn().mockResolvedValue(undefined);
    const performCleanup = jest.fn().mockResolvedValue(undefined);

    registerSignalHandlers({
      getContainersStarted: () => false,
      keepContainers: false,
      fastKillAgentContainer: fastKill,
      performCleanup,
    });

    harness.handlers['SIGTERM']();
    await flushPromises();

    expect(fastKill).not.toHaveBeenCalled();
    expect(performCleanup).toHaveBeenCalledWith('SIGTERM');
    expect(harness.processExitSpy).toHaveBeenCalledWith(143);
  });
});

// ─── preflight.ts — String(error) branches for non-Error throws ──────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('./logger', () => require('./test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('./config-file');
jest.mock('./config-mapper');
jest.mock('./config-precedence');
jest.mock('./domain-utils');
jest.mock('./rules');
jest.mock('./domain-validation');
jest.mock('./option-parsers');
jest.mock('./copilot-api-resolver');
jest.mock('./api-proxy-config');

import {
  applyConfigFilePrecedence,
  parseDomainOptions,
  resolveBlockedDomains,
} from './commands/preflight';
import { logger } from './logger';
import * as configFile from './config-file';
import * as domainUtils from './domain-utils';
import * as rules from './rules';
import * as domainValidation from './domain-validation';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedConfigFile = configFile as jest.Mocked<typeof configFile>;
const mockedDomainUtils = domainUtils as jest.Mocked<typeof domainUtils>;
const mockedRules = rules as jest.Mocked<typeof rules>;
const mockedDomainValidation = domainValidation as jest.Mocked<typeof domainValidation>;

describe('applyConfigFilePrecedence — String(error) branch (line 51)', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => { processExitSpy.mockRestore(); });

  it('formats error via String(error) when a non-Error object is thrown', () => {
    // Throwing a plain string exercises the `String(error)` branch at line 51.
    mockedConfigFile.loadAwfFileConfig.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'plain-string-config-error';
    });

    expect(() =>
      applyConfigFilePrecedence({ config: '/cfg.yml' }, () => undefined)
    ).toThrow('process.exit called');

    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('plain-string-config-error')
    );
  });
});

describe('parseDomainOptions — String/non-Error branches (lines 73, 82)', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockedDomainUtils.parseDomains.mockReturnValue([]);
    mockedDomainUtils.parseDomainsFile.mockReturnValue([]);
    mockedRules.loadAndMergeDomains.mockReturnValue([]);
  });

  afterEach(() => { processExitSpy.mockRestore(); });

  it('uses non-Error value directly when parseDomainsFile throws a non-Error (line 73)', () => {
    mockedDomainUtils.parseDomainsFile.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 42;
    });

    expect(() => parseDomainOptions({ allowDomainsFile: '/missing.txt' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to read domains file: 42')
    );
  });

  it('uses non-Error value directly when loadAndMergeDomains throws a non-Error (line 82)', () => {
    mockedRules.loadAndMergeDomains.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'yaml-parse-error';
    });

    expect(() => parseDomainOptions({ rulesetFile: ['/bad.yml'] })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to load ruleset file: yaml-parse-error')
    );
  });
});

describe('resolveBlockedDomains — non-Error in validateDomainOrPattern (line 217)', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    mockedDomainUtils.parseDomains.mockReturnValue([]);
    mockedDomainUtils.parseDomainsFile.mockReturnValue([]);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation();
  });

  afterEach(() => { processExitSpy.mockRestore(); });

  it('uses non-Error value directly when validateDomainOrPattern throws a non-Error (line 217)', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['bad!domain']);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw 'string validation error';
    });

    expect(() => resolveBlockedDomains({ blockDomains: 'bad!domain' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Invalid blocked domain or pattern: string validation error')
    );
  });
});

// ─── compose-generator.ts ─────────────────────────────────────────────────────

jest.mock('./services/host-gateway', () => ({
  resolveDockerHostGateway: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('./test-helpers/mock-execa.test-utils').execaMockFactory());

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateDockerCompose, redactDockerComposeSecrets } from './compose-generator';
import { baseConfig, mockNetworkConfig } from './test-helpers/docker-test-fixtures.test-utils';
import type { WrapperConfig } from './types';

describe('generateDockerCompose — GITHUB_WORKSPACE branch (line 84)', () => {
  let mockConfig: WrapperConfig;
  const savedGW = process.env.GITHUB_WORKSPACE;

  beforeEach(() => {
    mockConfig = { ...baseConfig, workDir: fs.mkdtempSync(path.join(os.tmpdir(), 'awf-test-')) };
  });

  afterEach(() => {
    fs.rmSync(mockConfig.workDir, { recursive: true, force: true });
    if (savedGW === undefined) {
      delete process.env.GITHUB_WORKSPACE;
    } else {
      process.env.GITHUB_WORKSPACE = savedGW;
    }
  });

  it('uses process.cwd() when GITHUB_WORKSPACE is not set (line 84 || branch)', () => {
    delete process.env.GITHUB_WORKSPACE;
    // Must not throw and must produce a valid compose config
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    expect(result.services.agent).toBeDefined();
  });

  it('uses GITHUB_WORKSPACE when the env var is set (line 84 truthy branch)', () => {
    process.env.GITHUB_WORKSPACE = '/github/workspace';
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    expect(result.services.agent).toBeDefined();
  });
});

describe('redactDockerComposeSecrets — service without environment (line 152)', () => {
  it('handles a service that has no environment key at all', () => {
    const compose = {
      services: {
        'plain-service': {
          image: 'ubuntu:22.04',
          // deliberately no environment key
        },
        'secret-service': {
          image: 'ubuntu:22.04',
          environment: {
            SECRET_KEY: 'should-be-redacted',
            NORMAL_VAR: 'kept',
          },
        },
      },
      networks: {},
    };

    const result = redactDockerComposeSecrets(compose as any);

    // Service without environment: no environment property added
    expect((result.services['plain-service'] as any).environment).toBeUndefined();
    // Service with sensitive key is redacted
    expect((result.services['secret-service'] as any).environment['SECRET_KEY']).toBe('[REDACTED]');
    expect((result.services['secret-service'] as any).environment['NORMAL_VAR']).toBe('kept');
  });
});

// ─── compose-network.ts — squidService.networks truthy (line 37) ─────────────

import { buildComposeNetworks } from './compose-network';

describe('buildComposeNetworks — networkIsolation with pre-existing squid networks (line 37)', () => {
  it('merges awf-ext with pre-existing squidService.networks entries', () => {
    const squidService: Record<string, unknown> = {
      image: 'squid:latest',
      // networks already set — exercises the truthy branch of `|| {}`
      networks: { 'awf-net': { ipv4_address: '172.30.0.10' } },
    };
    const agentService: Record<string, unknown> = {
      image: 'ubuntu:22.04',
      networks: { 'awf-net': {} },
    };

    const result = buildComposeNetworks({
      services: { 'squid-proxy': squidService, agent: agentService },
      squidService,
      agentService,
      networkIsolation: true,
      networkConfig: {
        subnet: '172.30.0.0/24',
        squidIp: '172.30.0.10',
        agentIp: '172.30.0.20',
      },
      namedVolumes: undefined,
    });

    // squid must have both awf-net (original) and awf-ext (added)
    const squidNetworks = result.services['squid-proxy'].networks as Record<string, unknown>;
    expect(squidNetworks).toHaveProperty('awf-net');
    expect(squidNetworks).toHaveProperty('awf-ext');
    // Compose result must declare awf-ext as a bridge network
    expect((result.networks as any)['awf-ext']).toEqual({ driver: 'bridge' });
  });
});
