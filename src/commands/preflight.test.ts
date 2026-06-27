import { applyConfigFilePrecedence, resolveAllowedDomains, resolveBlockedDomains } from './preflight';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('../logger', () => require('../test-helpers/mock-logger.test-utils').loggerMockFactory());
jest.mock('../config-file');
jest.mock('../config-mapper');
jest.mock('../config-precedence');
jest.mock('../domain-utils');
jest.mock('../rules');
jest.mock('../domain-validation');
jest.mock('../option-parsers');
jest.mock('../copilot-api-resolver');
jest.mock('../api-proxy-config');

import { logger } from '../logger';
import * as configFile from '../config-file';
import * as configMapper from '../config-mapper';
import * as configPrecedence from '../config-precedence';
import * as domainUtils from '../domain-utils';
import * as rules from '../rules';
import * as domainValidation from '../domain-validation';
import * as optionParsers from '../option-parsers';
import * as copilotResolver from '../copilot-api-resolver';
import * as apiProxyConfig from '../api-proxy-config';

const mockedLogger = logger as jest.Mocked<typeof logger>;
const mockedConfigFile = configFile as jest.Mocked<typeof configFile>;
const mockedConfigMapper = configMapper as jest.Mocked<typeof configMapper>;
const mockedConfigPrecedence = configPrecedence as jest.Mocked<typeof configPrecedence>;
const mockedDomainUtils = domainUtils as jest.Mocked<typeof domainUtils>;
const mockedRules = rules as jest.Mocked<typeof rules>;
const mockedDomainValidation = domainValidation as jest.Mocked<typeof domainValidation>;
const mockedOptionParsers = optionParsers as jest.Mocked<typeof optionParsers>;
const mockedCopilotResolver = copilotResolver as jest.Mocked<typeof copilotResolver>;
const mockedApiProxyConfig = apiProxyConfig as jest.Mocked<typeof apiProxyConfig>;

describe('applyConfigFilePrecedence', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('does nothing when options.config is not set', () => {
    const options = {};
    applyConfigFilePrecedence(options, () => undefined);
    expect(mockedConfigFile.loadAwfFileConfig).not.toHaveBeenCalled();
  });

  it('loads config file and applies options with CLI precedence', () => {
    const fileConfig = { version: 1, allowDomains: 'example.com' };
    const fileDerivedOptions = { allowDomains: 'example.com' };
    mockedConfigFile.loadAwfFileConfig.mockReturnValue(fileConfig as never);
    mockedConfigMapper.mapAwfFileConfigToCliOptions.mockReturnValue(fileDerivedOptions);
    mockedConfigPrecedence.applyConfigOptionsInPlaceWithCliPrecedence.mockImplementation();

    const options: Record<string, unknown> = { config: '/path/to/config.yml' };
    const getSource = jest.fn().mockReturnValue('default');
    applyConfigFilePrecedence(options, getSource);

    expect(mockedConfigFile.loadAwfFileConfig).toHaveBeenCalledWith('/path/to/config.yml');
    expect(mockedConfigMapper.mapAwfFileConfigToCliOptions).toHaveBeenCalledWith(fileConfig);
    expect(mockedConfigPrecedence.applyConfigOptionsInPlaceWithCliPrecedence).toHaveBeenCalledWith(
      options,
      fileDerivedOptions,
      expect.any(Function)
    );
  });

  it('exits on config file load error', () => {
    mockedConfigFile.loadAwfFileConfig.mockImplementation(() => {
      throw new Error('File not found');
    });

    const options: Record<string, unknown> = { config: '/bad/path.yml' };
    expect(() => applyConfigFilePrecedence(options, () => undefined)).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('File not found'));
  });

  it('only applies config value when flag was not set via CLI', () => {
    const fileConfig = {};
    const fileDerivedOptions = {};
    mockedConfigFile.loadAwfFileConfig.mockReturnValue(fileConfig as never);
    mockedConfigMapper.mapAwfFileConfigToCliOptions.mockReturnValue(fileDerivedOptions);

    let capturedPredicate: ((name: string) => boolean) | undefined;
    mockedConfigPrecedence.applyConfigOptionsInPlaceWithCliPrecedence.mockImplementation(
      (_opts, _derived, predicate) => { capturedPredicate = predicate; }
    );

    const options: Record<string, unknown> = { config: '/path/to/config.yml' };
    const getSource = jest.fn().mockImplementation((name) => name === 'allowDomains' ? 'cli' : 'default');
    applyConfigFilePrecedence(options, getSource);

    expect(capturedPredicate).toBeDefined();
    // CLI flag should be kept (predicate returns true → "has cli flag")
    expect(capturedPredicate!('allowDomains')).toBe(true);
    // Non-CLI flag should be overridable
    expect(capturedPredicate!('workDir')).toBe(false);
  });
});

describe('resolveAllowedDomains', () => {
  let processExitSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    processExitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    // Default mocks
    mockedDomainUtils.parseDomains.mockReturnValue([]);
    mockedDomainUtils.parseDomainsFile.mockReturnValue([]);
    mockedRules.loadAndMergeDomains.mockReturnValue([]);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation();
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: [],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    });
    mockedCopilotResolver.resolveCopilotApiRouting.mockReturnValue({
      copilotApiTarget: undefined,
      copilotApiBasePath: undefined,
    });
    mockedApiProxyConfig.resolveApiTargetsToAllowedDomains.mockReturnValue([]);
  });

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('returns empty allowedDomains when no options are set', () => {
    const result = resolveAllowedDomains({});
    expect(result.allowedDomains).toEqual([]);
    expect(result.localhostResult.localhostDetected).toBe(false);
  });

  it('parses domains from --allow-domains flag', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['example.com']);
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['example.com'],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    });

    const result = resolveAllowedDomains({ allowDomains: 'example.com' });
    expect(mockedDomainUtils.parseDomains).toHaveBeenCalledWith('example.com');
    expect(result.allowedDomains).toContain('example.com');
  });

  it('parses domains from --allow-domains-file', () => {
    mockedDomainUtils.parseDomainsFile.mockReturnValue(['file-domain.com']);
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['file-domain.com'],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    });

    const result = resolveAllowedDomains({ allowDomainsFile: '/path/to/domains.txt' });
    expect(mockedDomainUtils.parseDomainsFile).toHaveBeenCalledWith('/path/to/domains.txt');
    expect(result.allowedDomains).toContain('file-domain.com');
  });

  it('exits when domains file cannot be read', () => {
    mockedDomainUtils.parseDomainsFile.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => resolveAllowedDomains({ allowDomainsFile: '/missing.txt' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to read domains file'));
  });

  it('merges domains from --ruleset-file', () => {
    mockedRules.loadAndMergeDomains.mockReturnValue(['ruleset-domain.com']);
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['ruleset-domain.com'],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    });

    const result = resolveAllowedDomains({ rulesetFile: ['/path/to/ruleset.yml'] });
    expect(mockedRules.loadAndMergeDomains).toHaveBeenCalled();
    expect(result.allowedDomains).toContain('ruleset-domain.com');
  });

  it('exits when ruleset file fails to load', () => {
    mockedRules.loadAndMergeDomains.mockImplementation(() => {
      throw new Error('Bad YAML');
    });

    expect(() => resolveAllowedDomains({ rulesetFile: ['/bad.yml'] })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to load ruleset file'));
  });

  it('logs debug when no domains are specified', () => {
    resolveAllowedDomains({});
    expect(mockedLogger.debug).toHaveBeenCalledWith(expect.stringContaining('No allowed domains specified'));
  });

  it('exits when domain validation fails', () => {
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['bad domain!'],
      localhostDetected: false,
      shouldEnableHostAccess: false,
    });
    mockedApiProxyConfig.resolveApiTargetsToAllowedDomains.mockReturnValue(['bad domain!']);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => {
      throw new Error('Invalid domain');
    });
    // override default parseDomains to return something
    mockedDomainUtils.parseDomains.mockReturnValue(['bad domain!']);

    expect(() => resolveAllowedDomains({ allowDomains: 'bad domain!' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid domain or pattern'));
  });

  it('handles localhost keyword detection', () => {
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['host.docker.internal'],
      localhostDetected: true,
      shouldEnableHostAccess: true,
      defaultPorts: '3000,8080',
    });
    mockedDomainUtils.parseDomains.mockReturnValue(['localhost']);

    const options: Record<string, unknown> = { allowDomains: 'localhost' };
    const result = resolveAllowedDomains(options);

    expect(result.localhostResult.localhostDetected).toBe(true);
    expect(options.enableHostAccess).toBe(true);
    expect(options.allowHostPorts).toBe('3000,8080');
    expect(mockedLogger.warn).toHaveBeenCalledWith(expect.stringContaining('localhost keyword enables host access'));
  });

  it('returns resolved Copilot API target from resolver', () => {
    mockedCopilotResolver.resolveCopilotApiRouting.mockReturnValue({
      copilotApiTarget: 'custom.copilot.com',
      copilotApiBasePath: '/v1',
    });

    const result = resolveAllowedDomains({});
    expect(result.resolvedCopilotApiTarget).toBe('custom.copilot.com');
    expect(result.resolvedCopilotApiBasePath).toBe('/v1');
  });

  it('handles localhost detected but shouldEnableHostAccess=false', () => {
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['localhost'],
      localhostDetected: true,
      shouldEnableHostAccess: false,
    });
    mockedDomainUtils.parseDomains.mockReturnValue(['localhost']);

    const options: Record<string, unknown> = { allowDomains: 'localhost' };
    const result = resolveAllowedDomains(options);

    expect(result.localhostResult.localhostDetected).toBe(true);
    // enableHostAccess should NOT be set when shouldEnableHostAccess is false
    expect(options.enableHostAccess).toBeUndefined();
    expect(mockedLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining('localhost keyword enables host access')
    );
  });

  it('handles localhost detected without defaultPorts', () => {
    mockedOptionParsers.processLocalhostKeyword.mockReturnValue({
      allowedDomains: ['localhost'],
      localhostDetected: true,
      shouldEnableHostAccess: false,
      defaultPorts: undefined,
    });
    mockedDomainUtils.parseDomains.mockReturnValue(['localhost']);

    const options: Record<string, unknown> = { allowDomains: 'localhost' };
    resolveAllowedDomains(options);

    // allowHostPorts should NOT be set when defaultPorts is undefined
    expect(options.allowHostPorts).toBeUndefined();
  });

  it('skips ruleset merge when rulesetFile array is empty', () => {
    const result = resolveAllowedDomains({ rulesetFile: [] });
    expect(mockedRules.loadAndMergeDomains).not.toHaveBeenCalled();
    expect(result.allowedDomains).toEqual([]);
  });
});

describe('resolveBlockedDomains', () => {
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

  afterEach(() => {
    processExitSpy.mockRestore();
  });

  it('returns empty array when no blocked domain options are set', () => {
    const result = resolveBlockedDomains({});
    expect(result).toEqual([]);
  });

  it('parses blocked domains from --block-domains flag', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['blocked.com']);
    const result = resolveBlockedDomains({ blockDomains: 'blocked.com' });
    expect(result).toContain('blocked.com');
  });

  it('parses blocked domains from --block-domains-file', () => {
    mockedDomainUtils.parseDomainsFile.mockReturnValue(['file-blocked.com']);
    const result = resolveBlockedDomains({ blockDomainsFile: '/path/to/blocked.txt' });
    expect(result).toContain('file-blocked.com');
  });

  it('exits when blocked domains file cannot be read', () => {
    mockedDomainUtils.parseDomainsFile.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(() => resolveBlockedDomains({ blockDomainsFile: '/missing.txt' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Failed to read blocked domains file'));
  });

  it('removes duplicate blocked domains', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['dup.com', 'dup.com', 'other.com']);
    const result = resolveBlockedDomains({ blockDomains: 'dup.com,dup.com,other.com' });
    expect(result).toEqual(['dup.com', 'other.com']);
  });

  it('exits when a blocked domain is invalid', () => {
    mockedDomainUtils.parseDomains.mockReturnValue(['bad domain!']);
    mockedDomainValidation.validateDomainOrPattern.mockImplementation(() => {
      throw new Error('Invalid');
    });

    expect(() => resolveBlockedDomains({ blockDomains: 'bad domain!' })).toThrow('process.exit called');
    expect(mockedLogger.error).toHaveBeenCalledWith(expect.stringContaining('Invalid blocked domain or pattern'));
  });
});
