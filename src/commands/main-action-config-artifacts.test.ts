import './main-action-enclave-mocks.test-utils';
import { mainActionFsMocks } from './main-action-fs-mock.test-utils';
import { createMainAction, testHelpers } from './main-action';
import { publishEarlyResolvedConfig } from '../resolved-config-artifact';
import * as enclaveManager from '../enclave/manager';
import * as credentialHiding from '../services/agent-volumes/credential-hiding';
import {
  MAIN_ACTION_STUB_CONFIG,
  getMainActionMocks,
  setupMainActionPlatformHarness,
} from './main-action.test-utils';

const {
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  chmodSync: mockChmodSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
} = mainActionFsMocks;

const {
  mockedLogger,
  mockedDockerManager,
  mockedRedactSecrets,
  mockedValidateOptions,
} = getMainActionMocks();
const mockedEnclaveManager = enclaveManager as jest.Mocked<typeof enclaveManager>;

describe('createMainAction', () => {
  const platformHarness = setupMainActionPlatformHarness();
  let getOptionValueSource: jest.Mock;

  beforeEach(() => {
    mockedEnclaveManager.prepareEnclaves.mockResolvedValue(undefined);
    mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 0, blockedDomains: [] });
    mockedRedactSecrets.deriveSensitiveEndpointForms.mockImplementation((domains?: string[]) =>
      domains ?? []
    );
    mockedRedactSecrets.redactSensitiveValues.mockImplementation((value: string, values: string[]) =>
      values.reduce((redacted, sensitive) => redacted.split(sensitive).join('[REDACTED]'), value)
    );
    getOptionValueSource = platformHarness.getOptionValueSource;
  });

  describe('redaction of sensitive config fields', () => {
    it('does not log API keys in debug output', async () => {
      const configWithKeys = {
        ...MAIN_ACTION_STUB_CONFIG,
        openaiApiKey: 'sk-secret',
        anthropicApiKey: 'ant-secret',
        copilotGithubToken: 'ghp-secret',
        geminiApiKey: 'gem-secret',
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithKeys as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      // Debug call should be made but without raw API keys
      const debugCalls = mockedLogger.debug.mock.calls;
      const configDebugCall = debugCalls.find((args) =>
        String(args[0]).includes('Configuration')
      );
      expect(configDebugCall).toBeDefined();
      const serialized = String(configDebugCall?.[1]);
      expect(serialized).not.toContain('sk-secret');
      expect(serialized).not.toContain('ant-secret');
      expect(serialized).not.toContain('ghp-secret');
      expect(serialized).not.toContain('cop-secret');
      expect(serialized).not.toContain('gem-secret');
    });
  });

  describe('resolved config artifact', () => {
    beforeEach(() => {
      mockMkdirSync.mockReset();
      mockWriteFileSync.mockReset();
      mockChmodSync.mockReset();
      mockOpenSync.mockReset();
      mockOpenSync.mockReturnValue(42);
      mockCloseSync.mockReset();
    });

    afterEach(() => jest.restoreAllMocks());

    it('publishes independently of the shared audit directory', async () => {
      const configWithAudit = {
        ...MAIN_ACTION_STUB_CONFIG,
        auditDir: '/tmp/awf-audit',
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithAudit as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(publishEarlyResolvedConfig).toHaveBeenCalledWith(expect.stringContaining('"allowedDomains"'));
      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      const writtenJson = calls[calls.length - 1][0];
      expect(writtenJson).not.toContain('ApiKey');
      expect(writtenJson).not.toContain('GithubToken');
    });

    it('redacts secret values in agentCommand in the artifact', async () => {
      const secretValue = 'super-secret-token-12345';
      const configWithSecret = {
        ...MAIN_ACTION_STUB_CONFIG,
        auditDir: '/tmp/awf-audit',
        agentCommand: `my-agent --token ${secretValue}`,
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithSecret as unknown as import('../types').WrapperConfig
      );
      // Make redactSecrets actually remove the secret value
      mockedRedactSecrets.redactSecrets.mockImplementation((s: string) =>
        s.replace(secretValue, '[REDACTED]')
      );

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      const writtenJson = calls[calls.length - 1][0];
      expect(writtenJson).not.toContain(secretValue);
      expect(writtenJson).toContain('[REDACTED]');
    });

    it('does not place the early artifact beneath a private workDir', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue(MAIN_ACTION_STUB_CONFIG);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(publishEarlyResolvedConfig).toHaveBeenCalledWith(expect.any(String));
      expect(mockOpenSync).not.toHaveBeenCalledWith(
        '/synthetic/awf-test/audit/awf-resolved-config.json', 'wx', 0o600);
    });
  });

  describe('extracted helper functions', () => {
    it('redactConfigForLogging removes sensitive keys and redacts agentCommand', () => {
      const secretValue = 'secret-123';
      const configWithSecrets = {
        ...MAIN_ACTION_STUB_CONFIG,
        agentCommand: `agent --token ${secretValue}`,
        openaiApiKey: 'sk-secret',
      } as unknown as import('../types').WrapperConfig;
      mockedRedactSecrets.redactSecrets.mockImplementation((s: string) =>
        s.replace(secretValue, '[REDACTED]')
      );

      const redacted = testHelpers.redactConfigForLogging(configWithSecrets);

      expect(redacted).not.toHaveProperty('openaiApiKey');
      expect(redacted.agentCommand).toContain('[REDACTED]');
      expect(redacted.agentCommand).not.toContain(secretValue);
    });

    it('redactConfigForLogging redacts additionalEnv object values', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: { ANTHROPIC_API_KEY: 'sk-real', GH_TOKEN: 'token123' },
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toEqual({
        ANTHROPIC_API_KEY: '[REDACTED]',
        GH_TOKEN: '[REDACTED]',
      });
    });

    it('omits host-only broker and bootstrap env configuration from resolved artifacts', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: {
          AWF_COPILOT_TOKEN_BROKER: 'true',
          GH_AW_TOKEN_BROKER_URL: 'https://broker.example.com/mint',
          ACTIONS_ID_TOKEN_REQUEST_URL: 'https://pipelines.actions.githubusercontent.com/idtoken',
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'bootstrap-only',
          KEEP: 'public-value',
        },
      } as import('../types').WrapperConfig);
      expect(redacted.additionalEnv).toEqual({ KEEP: '[REDACTED]' });
    });

    it('redactConfigForLogging preserves null additionalEnv', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: null as unknown as Record<string, string>,
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toBeNull();
    });

    it('redactConfigForLogging preserves non-object additionalEnv values', () => {
      const redacted = testHelpers.redactConfigForLogging({
        ...MAIN_ACTION_STUB_CONFIG,
        additionalEnv: 'raw-env-string' as unknown as Record<string, string>,
      } as unknown as import('../types').WrapperConfig);

      expect(redacted.additionalEnv).toBe('raw-env-string');
    });

    it.each(['/host', '/tmp/gh-aw', '/tmp'])(
      'publishes ARC/DinD runner mount paths with prefix %s without changing config',
      (dockerHostPathPrefix) => {
        const source = '/home/runner/_work/_temp/gh-aw/sandbox/agent/logs';
        const target = '/tmp/gh-aw/sandbox/agent/logs';
        const config = {
          ...MAIN_ACTION_STUB_CONFIG,
          runnerTopology: 'arc-dind' as const,
          dockerHostPathPrefix,
          volumeMounts: [`${source}:${target}:rw`],
        };
        testHelpers.persistConfigAuditArtifact(config, { agentCommand: 'redacted' });
        const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
        expect(JSON.parse(calls[calls.length - 1][0])).toEqual({
          agentCommand: 'redacted',
          runnerMountPaths: [{
            sandboxPath: target,
            runnerPath: dockerHostPathPrefix === '/tmp' ? `/tmp${source}` : source,
          }],
        });
        expect(config.volumeMounts).toEqual([`${source}:${target}:rw`]);
        expect(config).not.toHaveProperty('runnerMountPaths');
      },
    );

    it('does not publish explicit mounts removed by the ARC sysroot filter', () => {
      const source = '/home/runner/_work/_temp/gh-aw/sandbox/agent/logs';
      const target = '/tmp/gh-aw/sandbox/agent/logs';
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        runnerTopology: 'arc-dind' as const,
        dockerHostPathPrefix: '/host',
        volumeMounts: [
          '/usr:/opt:rw',
          `${MAIN_ACTION_STUB_CONFIG.workDir}/logs:/tmp/private-logs:rw`,
          `${source}:${target}:rw`,
        ],
      };
      testHelpers.persistConfigAuditArtifact(config, {});
      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      expect(JSON.parse(calls[calls.length - 1][0]).runnerMountPaths).toEqual([
        { sandboxPath: target, runnerPath: source },
      ]);
    });

    it('does not publish a custom bind hidden by a credential overlay', () => {
      const source = '/home/runner/_work/_temp/config.yml';
      const target = '/tmp/agent-logs/config.yml';
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        runnerTopology: 'arc-dind' as const,
        dockerHostPathPrefix: '/host',
        volumeMounts: [`${source}:${target}:rw`],
      };
      const overlays = jest.spyOn(credentialHiding, 'buildCredentialHidingOverlays')
        .mockReturnValue([`/dev/null:/host${target}:ro`]);

      try {
        testHelpers.persistConfigAuditArtifact(config, {});
      } finally {
        overlays.mockRestore();
      }

      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      expect(JSON.parse(calls[calls.length - 1][0]).runnerMountPaths).toEqual([]);
    });

    it.each(['/tmp/root:/host:rw', '/tmp/root:/host/:rw'])(
      'does not publish a root bind replaced by the ARC sysroot (%s)',
      (rootMount) => {
        const config = {
          ...MAIN_ACTION_STUB_CONFIG,
          runnerTopology: 'arc-dind' as const,
          dockerHostPathPrefix: '/host',
          volumeMounts: [rootMount],
        };

        testHelpers.persistConfigAuditArtifact(config, {});

        const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
        expect(JSON.parse(calls[calls.length - 1][0]).runnerMountPaths).toEqual([]);
      },
    );

    it('does not publish compose mount mappings for other topologies', () => {
      testHelpers.persistConfigAuditArtifact(MAIN_ACTION_STUB_CONFIG, { agentCommand: 'redacted' });
      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      expect(JSON.parse(calls[calls.length - 1][0])).toEqual({ agentCommand: 'redacted' });
    });

    it('persistConfigAuditArtifact warns when publishing the artifact fails', () => {
      jest.mocked(publishEarlyResolvedConfig).mockImplementationOnce(() => {
        throw new Error('write failed');
      });

      testHelpers.persistConfigAuditArtifact(MAIN_ACTION_STUB_CONFIG, { foo: 'bar' });

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        'Failed to publish resolved config artifact:', expect.any(Error),
      );
    });
  });
});
