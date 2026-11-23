import './main-action-enclave-mocks.test-utils';
import { mainActionFsMocks } from './main-action-fs-mock.test-utils';
import { constants as fsConstants } from 'fs';
import { createMainAction, testHelpers } from './main-action';
import { publishEarlyResolvedConfig } from '../resolved-config-artifact';
import {
  MAIN_ACTION_STUB_CONFIG,
  describeMainAction,
  makeSbxConfig,
} from './main-action.test-utils';
import type { WrapperConfig } from '../types';
import { CloudHypervisorUnsupportedHostError } from '../cloud-hypervisor/errors';
import { initializeEnclaveStartupProgress, updateEnclaveStartupProgress } from '../enclave/startup-progress';
import { normalizeEnclavesConfig } from '../parsers/enclave-parser';
import {
  ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV,
  releaseStaticGithubExecutorCapability,
} from '../enclave/static-github-handoff';
import * as enclaveMountPolicy from '../enclave/mount-policy';

const {
  mkdirSync: mockMkdirSync,
  writeFileSync: mockWriteFileSync,
  openSync: mockOpenSync,
  closeSync: mockCloseSync,
  lstatSync: mockLstatSync,
  fstatSync: mockFstatSync,
  fchmodSync: mockFchmodSync,
  fsyncSync: mockFsyncSync,
} = mainActionFsMocks;

describeMainAction(({
  mockedLogger,
  mockedDockerManager,
  mockedHostIptables,
  mockedCliWorkflow,
  mockedRedactSecrets,
  mockedDindProbe,
  mockedDindBootstrap,
  mockedPreflight,
  mockedSignalHandler,
  mockedValidateOptions,
  mockedSbxManager,
  mockedExternalRuntimeResolver,
  mockedEnclaveManager,
  platformHarness,
}) => {
  let processExitSpy: jest.SpyInstance;
  let getOptionValueSource: jest.Mock;

  beforeEach(() => {
    processExitSpy = platformHarness.processExitSpy;
    getOptionValueSource = platformHarness.getOptionValueSource;
  });

  describe('happy path', () => {
    it.each([
      ['copilot -p fixture', true],
      ['bash -c copilot', false],
    ])('wires the Docker observation producer only for direct selections: %s', async (agentCommand, supported) => {
      mockedValidateOptions.validateOptions.mockReturnValueOnce({
        ...MAIN_ACTION_STUB_CONFIG, agentCommand,
      });
      await createMainAction(getOptionValueSource)([agentCommand], {});
      const dependencies = mockedCliWorkflow.runMainWorkflow.mock.calls[0][1];
      expect(typeof dependencies.probeHarness).toBe(supported ? 'function' : 'undefined');
      expect(typeof dependencies.releaseHarness).toBe(supported ? 'function' : 'undefined');
    });

    it('calls workflow steps and exits with 0', async () => {
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(0);
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(0);
    });

    it('calls applyConfigFilePrecedence with options and resolver', async () => {
      const options = { keepContainers: false };
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], options);
      expect(mockedPreflight.applyConfigFilePrecedence).toHaveBeenCalledWith(
        options,
        getOptionValueSource
      );
    });

    it('calls setAwfDockerHost with config.awfDockerHost', async () => {
      const configWithDockerHost = { ...MAIN_ACTION_STUB_CONFIG, awfDockerHost: '/var/run/docker.sock' };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithDockerHost as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDockerManager.setAwfDockerHost).toHaveBeenCalledWith('/var/run/docker.sock');
    });

    it('passes containerRuntime through to runAgentCommand', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        containerRuntime: 'gvisor',
      } as unknown as import('../types').WrapperConfig);
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps) => {
        await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 10);
        return 0;
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDockerManager.runAgentCommand).toHaveBeenCalledWith(
        '/tmp/awf-test',
        ['github.com'],
        undefined,
        10,
        'gvisor'
      );
    });

    it('registers signal handlers', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedSignalHandler.registerSignalHandlers).toHaveBeenCalled();
    });

    it('runs DinD bootstrap before workflow execution', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedDindBootstrap.runDindBootstrap).toHaveBeenCalledWith(MAIN_ACTION_STUB_CONFIG);
    });

    it('checks retained debug artifacts before a primary run without enclaves', async () => {
      const check = jest.spyOn(enclaveMountPolicy, 'assertPersistentDebugArtifactsIsolated')
        .mockImplementation(() => undefined);
      try {
        const action = createMainAction(getOptionValueSource);
        await action(['echo hi'], {});
        expect(check).toHaveBeenCalledTimes(1);
        expect(check.mock.calls[0][0].workDir).toBe(MAIN_ACTION_STUB_CONFIG.workDir);
        expect(check.mock.calls[0][0].enclaves).toBeUndefined();
      } finally {
        check.mockRestore();
      }
    });

    it('skips probe and DinD bootstrap when dockerHostPathPrefix is already set', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        dockerHostPathPrefix: '/host',
      } as unknown as import('../types').WrapperConfig);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedDindProbe.probeSplitFilesystem).not.toHaveBeenCalled();
      expect(mockedDindBootstrap.runDindBootstrap).not.toHaveBeenCalled();
    });

    it('takes scoped GitHub capability custody before the Docker filesystem probe', async () => {
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: normalizeEnclavesConfig([{
          runtime: 'cloud-hypervisor',
          agent: {
            model: 'gpt-test',
            tools: { github: { allowed: ['issue_read'], allowedRepos: ['octo/private'] } },
          },
          repos: [{ repo: 'octo/private', sensitivity: 'confidential' }],
        }]),
      } as WrapperConfig;
      const envNames = [
        ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV,
        'AWF_ENCLAVE_GITHUB_MCP_AGENT_ID',
        'AWF_ENCLAVE_MCP_GATEWAY_IDENTITY',
      ];
      const previousEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
      const agentId = 'a'.repeat(40);
      const now = Date.now();
      Object.assign(process.env, {
        AWF_ENCLAVE_MCP_GATEWAY_IDENTITY: 'compiler-run-123',
        AWF_ENCLAVE_GITHUB_MCP_AGENT_ID: agentId,
        [ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]: JSON.stringify({
          version: 1,
          gatewayIdentity: 'compiler-run-123',
          executor: 'agent',
          agentId,
          bearer: 'scoped-executor-capability-for-cli-ordering-test',
          issuedAt: now - 1000,
          expiresAt: now + 300_000,
          allowedTools: ['issue_read'],
          allowedRepos: ['octo/private'],
          minIntegrity: null,
        }),
      });
      mockedValidateOptions.validateOptions.mockReturnValueOnce(config);
      mockedDindProbe.probeSplitFilesystem.mockImplementationOnce(async () => {
        expect(process.env[ENCLAVE_GITHUB_EXECUTOR_CAPABILITY_ENV]).toBeUndefined();
        expect(process.env.AWF_ENCLAVE_GITHUB_MCP_AGENT_ID).toBeUndefined();
        return { prefix: undefined, splitDetected: false, inconclusive: false };
      });

      try {
        await createMainAction(getOptionValueSource)(['echo hi'], {});
      } finally {
        releaseStaticGithubExecutorCapability(config);
        for (const [name, value] of Object.entries(previousEnv)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
      expect(mockedDindProbe.probeSplitFilesystem).toHaveBeenCalledTimes(1);
    });

    it('auto-applies detected DinD prefix and logs info', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: '/host',
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Auto-applied --docker-host-path-prefix /host')
      );
    });

    it('publishes runner paths after auto-detecting a daemon-only DinD prefix', async () => {
      const source = '/home/runner/_work/_temp/gh-aw/sandbox/agent/logs';
      const target = '/tmp/gh-aw/sandbox/agent/logs';
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        runnerTopology: 'arc-dind',
        volumeMounts: [`${source}:${target}:rw`],
      });
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: '/tmp/gh-aw', splitDetected: true, inconclusive: false,
      });

      await createMainAction(getOptionValueSource)(['echo hi'], {});

      const calls = jest.mocked(publishEarlyResolvedConfig).mock.calls;
      const published = JSON.parse(calls[calls.length - 1][0]);
      expect(published.dockerHostPathPrefix).toBe('/tmp/gh-aw');
      expect(published.runnerMountPaths).toEqual([
        { sandboxPath: target, runnerPath: source },
      ]);
    });

    it('logs warning when split filesystem is detected without a known prefix', async () => {
      mockedDindProbe.probeSplitFilesystem.mockResolvedValue({
        prefix: undefined,
        splitDetected: true,
        inconclusive: false,
      });

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Split runner/daemon filesystem detected')
      );
    });

    it('logs empty DNS servers when dnsServers is undefined', async () => {
      mockedValidateOptions.validateOptions.mockReturnValue({
        ...MAIN_ACTION_STUB_CONFIG,
        dnsServers: undefined,
      } as unknown as import('../types').WrapperConfig);

      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});

      expect(mockedLogger.debug).toHaveBeenCalledWith('DNS servers: ');
    });

    it('logs allowed domains', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('github.com')
      );
    });

    it('logs blocked domains when present', async () => {
      const configWithBlocked = {
        ...MAIN_ACTION_STUB_CONFIG,
        blockedDomains: ['evil.com'],
      };
      mockedValidateOptions.validateOptions.mockReturnValue(
        configWithBlocked as unknown as import('../types').WrapperConfig
      );
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      expect(mockedLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('evil.com')
      );
    });

    it('does not log blocked domains when empty', async () => {
      const action = createMainAction(getOptionValueSource);
      await action(['echo hi'], {});
      const blockedCalls = mockedLogger.info.mock.calls.filter(
        (args) => String(args[0]).includes('Blocked domains')
      );
      expect(blockedCalls).toHaveLength(0);
    });
  });

  describe('when runMainWorkflow returns non-zero exit code', () => {
    it('exits with the non-zero code', async () => {
      mockedCliWorkflow.runMainWorkflow.mockResolvedValue(42);
      const action = createMainAction(getOptionValueSource);
      await action(['curl https://example.com'], {});
      expect(processExitSpy).toHaveBeenCalledWith(42);
    });

    it('emits an enclave exit marker before cleanup for a non-zero agent result', async () => {
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: normalizeEnclavesConfig([
          { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
        ]),
      } as unknown as import('../types').WrapperConfig;
      mockedValidateOptions.validateOptions.mockReturnValue(config);
      mockedDockerManager.runAgentCommand.mockResolvedValue({ exitCode: 42, blockedDomains: [] });
      mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, dependencies) => {
        const result = await dependencies.runAgentCommand('/tmp/awf-test', ['github.com']);
        return result.exitCode;
      });
      const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const action = createMainAction(getOptionValueSource);

      await action(['echo hi'], {});

      expect(write).toHaveBeenCalledWith(expect.stringMatching(
        /^AWF_STARTUP_EXIT .*"exitCode":42.*"cleanup":"pending"/,
      ));
    });

    describe('sbx runtime wiring', () => {
      it('passes configured mounts/workdir/environment into sbx create/exec', async () => {
        const sbxConfig = makeSbxConfig({
          containerWorkDir: '/home/runner/work/repo/repo',
          volumeMounts: ['/tmp/tooling:/tmp/tooling:ro'],
          enableApiProxy: true,
          tty: true,
        });
        mockedValidateOptions.validateOptions.mockReturnValue(sbxConfig);
        mockedCliWorkflow.runMainWorkflow.mockImplementation(async (_config, deps, _callbacks) => {
          await deps.startContainers('/tmp/awf-test', ['github.com']);
          const result = await deps.runAgentCommand('/tmp/awf-test', ['github.com'], undefined, 10);
          return result.exitCode;
        });

        const action = createMainAction(getOptionValueSource);
        await action(['echo hi'], {});

        expect(mockedSbxManager.createSandbox).toHaveBeenCalledWith(expect.objectContaining({
          extraMounts: ['/tmp/tooling:/tmp/tooling:ro'],
        }));
        expect(mockedSbxManager.assertSbxApiProxyReflect).toHaveBeenCalledWith(
          'awf-agent-test',
          expect.objectContaining({
            NO_PROXY: expect.stringContaining('api-proxy'),
          }),
          '/home/runner/work/repo/repo',
        );
        expect(mockedSbxManager.execInSandbox).toHaveBeenCalledWith(
          'awf-agent-test',
          'echo hi',
          expect.objectContaining({
            timeoutMinutes: 10,
            workDir: '/home/runner/work/repo/repo',
            tty: true,
            environment: expect.objectContaining({
              HTTPS_PROXY: expect.any(String),
              SQUID_PROXY_HOST: expect.any(String),
            }),
          }),
        );
      });

    });
  });

  describe('when runMainWorkflow throws', () => {
    it('calls performCleanup and exits with code 1', async () => {
      mockedCliWorkflow.runMainWorkflow.mockRejectedValue(new Error('docker failed'));
      const action = createMainAction(getOptionValueSource);
      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
      expect(mockedLogger.error).toHaveBeenCalledWith(
        'Fatal error:',
        expect.any(Error)
      );
      expect(mockedDockerManager.cleanup).toHaveBeenCalledWith(
        MAIN_ACTION_STUB_CONFIG.workDir,
        false,
        MAIN_ACTION_STUB_CONFIG.proxyLogsDir,
        MAIN_ACTION_STUB_CONFIG.auditDir,
        MAIN_ACTION_STUB_CONFIG.sessionStateDir,
        MAIN_ACTION_STUB_CONFIG.dockerHostPathPrefix,
        MAIN_ACTION_STUB_CONFIG.imageRegistry,
        MAIN_ACTION_STUB_CONFIG.imageTag,
        MAIN_ACTION_STUB_CONFIG.agentImage,
        MAIN_ACTION_STUB_CONFIG.images,
        MAIN_ACTION_STUB_CONFIG.tokenLogDir,
      );
      expect(mockedHostIptables.cleanupHostIptables).not.toHaveBeenCalled();
      expect(processExitSpy).toHaveBeenCalledWith(1);
    });

    it('writes a startup diagnostic marker for fatal workflow errors', async () => {
      mockedCliWorkflow.runMainWorkflow.mockRejectedValue(new Error('Refusing to use symlink as bind mountpoint: /usr/local/bin/npm'));
      const action = createMainAction(getOptionValueSource);

      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

      expect(mockMkdirSync).toHaveBeenCalledWith('/synthetic/awf-test/squid-logs', {
        recursive: true,
        mode: 0o700,
      });
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.stringContaining('Refusing to use symlink as bind mountpoint: /usr/local/bin/npm'),
      );
      expect(mockFchmodSync).toHaveBeenNthCalledWith(1, 42, 0o600);
      expect(mockFsyncSync).toHaveBeenCalledWith(42);
      expect(mockFchmodSync).toHaveBeenNthCalledWith(2, 42, 0o644);
    });

    it('does not classify agent command failures as startup failures', async () => {
      mockedCliWorkflow.runMainWorkflow.mockImplementationOnce(async (_config, dependencies) => {
        await dependencies.runAgentCommand('/tmp/awf-test', ['github.com']);
        throw new Error('agent command failed');
      });
      const action = createMainAction(getOptionValueSource);

      await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

      expect(mockWriteFileSync).not.toHaveBeenCalledWith(
        42,
        expect.stringContaining('"phase": "startup"'),
      );
    });

    it('redacts startup diagnostic error messages', async () => {
      mockedRedactSecrets.redactSecrets.mockReturnValue('[REDACTED]');

      testHelpers.writeStartupFailureDiagnostic(
        { ...MAIN_ACTION_STUB_CONFIG, proxyLogsDir: '/tmp/custom-logs' } as import('../types').WrapperConfig,
        new Error('secret-bearing failure'),
      );

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.stringContaining('[REDACTED]'),
      );
    });

    it('refuses symlinked log directories and diagnostic files', () => {
      (mockLstatSync as jest.Mock).mockReturnValueOnce({ isSymbolicLink: () => true });
      testHelpers.writeStartupFailureDiagnostic(MAIN_ACTION_STUB_CONFIG, new Error('startup failed'));
      expect(mockOpenSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();

      (mockLstatSync as jest.Mock).mockReturnValue({ isSymbolicLink: () => false });
      const symlinkError = Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
      mockOpenSync.mockImplementationOnce(() => { throw symlinkError; });
      testHelpers.writeStartupFailureDiagnostic(MAIN_ACTION_STUB_CONFIG, new Error('startup failed'));
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('refuses non-regular diagnostic files', () => {
      (mockFstatSync as jest.Mock).mockReturnValueOnce({ isFile: () => false });
      testHelpers.writeStartupFailureDiagnostic(MAIN_ACTION_STUB_CONFIG, new Error('startup failed'));
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockCloseSync).toHaveBeenCalledWith(42);
    });

    it.each([
      { nlink: 2, uid: process.getuid?.() },
      { nlink: 1, uid: (process.getuid?.() ?? 0) + 1 },
    ])('does not truncate a hardlinked or foreign-owned diagnostic', (stat) => {
      (mockFstatSync as jest.Mock).mockReturnValueOnce({ isFile: () => true, ...stat });
      testHelpers.writeStartupFailureDiagnostic(MAIN_ACTION_STUB_CONFIG, new Error('startup failed'));
      expect(mainActionFsMocks.ftruncateSync).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
      expect(mockOpenSync.mock.calls[0][1] & fsConstants.O_TRUNC).toBe(0);
      expect(mockCloseSync).toHaveBeenCalledWith(42);
    });

    it('persists bounded safe progress alongside fatal errors without copying their fields', () => {
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: normalizeEnclavesConfig([
          { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
        ]),
      };
      initializeEnclaveStartupProgress(config);
      updateEnclaveStartupProgress(config, {
        stage: 'initialize', readiness: 'attempted', attempts: 1,
        code: 'dns-not-found',
      });
      const sentinel = 'PRIVATE_TOKEN_PATH_IP_HOSTNAME_repository-sentinel';
      testHelpers.writeStartupFailureDiagnostic(config, Object.assign(
        new Error(sentinel.repeat(1024)), { code: sentinel, cause: sentinel, headers: sentinel },
      ));
      const record = JSON.parse(mockWriteFileSync.mock.calls[0][1]);
      expect(record.enclaveStartup).toEqual({
        schemaVersion: 1, perspective: 'awf-host', stage: 'initialize',
        readiness: 'attempted', code: 'dns-not-found', attempts: 1, httpStatus: null,
      });
      expect(record.phase).toBe('startup');
      expect(JSON.stringify(record)).not.toContain(sentinel);
      expect(Buffer.byteLength(mockWriteFileSync.mock.calls[0][1])).toBeLessThan(16 * 1024);
    });

    it('publishes progress before host bootstrap and preserves a not-attempted fatal record', async () => {
      const config = {
        ...MAIN_ACTION_STUB_CONFIG,
        enclaves: normalizeEnclavesConfig([
          { script: {}, repos: [{ repo: 'octo/private', sensitivity: 'internal' }] },
        ]),
      };
      mockedValidateOptions.validateOptions.mockReturnValueOnce(config);
      mockedDindProbe.probeSplitFilesystem.mockRejectedValueOnce(new Error('bootstrap failed'));
      await expect(createMainAction(getOptionValueSource)(['echo hi'], {}))
        .rejects.toThrow('process.exit: 1');
      const records = mockWriteFileSync.mock.calls
        .filter((call) => call[0] === 42)
        .map((call) => JSON.parse(call[1]));
      expect(records[0]).toMatchObject({
        phase: 'enclave-startup-progress', message: 'Enclave startup in progress',
        enclaveStartup: { stage: 'host-bootstrap', readiness: 'not-attempted', attempts: 0 },
      });
      expect(records[1]).toMatchObject({
        phase: 'startup', enclaveStartup: { stage: 'host-bootstrap', readiness: 'not-attempted' },
      });
    });

    it('redacts secret-derived endpoint forms from startup diagnostics', () => {
      mockedRedactSecrets.deriveSensitiveEndpointForms.mockReturnValue([
        'sensitive.example.com:443',
        'sensitive.example.com',
      ]);
      testHelpers.writeStartupFailureDiagnostic({
        ...MAIN_ACTION_STUB_CONFIG,
        sensitiveAllowedDomains: ['https://sensitive.example.com'],
      } as import('../types').WrapperConfig, new Error('failed to reach sensitive.example.com:443'));

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        42,
        expect.not.stringContaining('sensitive.example.com'),
      );
    });

    describe('when external runtime resolution fails', () => {
      it('uses fatal-error cleanup and exits with code 1', async () => {
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockImplementationOnce(() => {
          throw new Error('backend is not registered');
        });

        const action = createMainAction(getOptionValueSource);
        await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

        expect(mockedLogger.error).toHaveBeenCalledWith(
          'Fatal error:',
          expect.objectContaining({ message: 'backend is not registered' }),
        );
        expect(mockedDockerManager.cleanup).toHaveBeenCalled();
        expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
        expect(processExitSpy).toHaveBeenCalledWith(1);
      });
    });

    describe('when external runtime preflight fails', () => {
      it('falls back to the Docker backend when Cloud Hypervisor host support is missing', async () => {
        const fallbackConfig = {
          ...MAIN_ACTION_STUB_CONFIG,
          containerRuntime: 'cloud-hypervisor',
          cloudHypervisor: { previewEnabled: true },
        } as WrapperConfig;
        const backend = {
          runtime: 'cloud-hypervisor',
          preflight: jest.fn().mockRejectedValue(
            new CloudHypervisorUnsupportedHostError(
              'Cloud Hypervisor requires readable and writable /dev/kvm: ENOENT',
            ),
          ),
          start: jest.fn(),
          exec: jest.fn(),
          collectDiagnostics: jest.fn(),
          stop: jest.fn(),
        };
        mockedValidateOptions.validateOptions.mockReturnValueOnce(fallbackConfig);
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockReturnValueOnce(backend);
        mockedCliWorkflow.runMainWorkflow.mockImplementationOnce(
          async (_config, _dependencies, lifecycle) => {
            lifecycle.onContainersStarted?.();
            await lifecycle.performCleanup();
            return 0;
          },
        );

        const action = createMainAction(getOptionValueSource);
        await action(['echo hi'], {});

        expect(mockedLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('falling back to the standard Docker backend'),
        );
        expect(mockedCliWorkflow.runMainWorkflow).toHaveBeenCalledWith(
          expect.objectContaining({
            containerRuntime: undefined,
            cloudHypervisor: undefined,
          }),
          expect.objectContaining({
            startContainers: mockedDockerManager.startContainers,
          }),
          expect.anything(),
        );
      });

      it('aborts before entering the main workflow', async () => {
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockImplementationOnce(() => ({
          runtime: 'sbx',
          preflight: jest.fn().mockRejectedValue(new Error('preflight failed')),
          start: jest.fn(),
          exec: jest.fn(),
          collectDiagnostics: jest.fn(),
          stop: jest.fn(),
        }));

        const action = createMainAction(getOptionValueSource);
        await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');

        expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
        expect(mockedLogger.error).toHaveBeenCalledWith(
          'Fatal error:',
          expect.objectContaining({ message: 'preflight failed' }),
        );
      });

      it('does not fall back across workload backends when enclaves are enabled', async () => {
        const selectedConfig = {
          ...MAIN_ACTION_STUB_CONFIG,
          containerRuntime: 'cloud-hypervisor',
          cloudHypervisor: { previewEnabled: true },
          enclaves: { enabled: true },
        } as WrapperConfig;
        const failure = new CloudHypervisorUnsupportedHostError('KVM unavailable');
        mockedValidateOptions.validateOptions.mockReturnValueOnce(selectedConfig);
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockReturnValueOnce({
          runtime: 'cloud-hypervisor',
          preflight: jest.fn().mockRejectedValue(failure),
          start: jest.fn(), exec: jest.fn(), collectDiagnostics: jest.fn(), stop: jest.fn(),
        });
        const action = createMainAction(getOptionValueSource);
        await expect(action(['echo hi'], {})).rejects.toThrow('process.exit: 1');
        expect(selectedConfig.containerRuntime).toBe('cloud-hypervisor');
        expect(selectedConfig.cloudHypervisor).toBeDefined();
        expect(mockedCliWorkflow.runMainWorkflow).not.toHaveBeenCalled();
        expect(mockedLogger.warn).not.toHaveBeenCalledWith(
          expect.stringContaining('falling back to the standard Docker backend'),
        );
        const startupDiagnostic = mockWriteFileSync.mock.calls
          .map((call) => String(call[1]))
          .filter((contents) => contents.includes('"enclave-runtime/primary-runtime"'))
          .slice(-1)[0];
        expect(startupDiagnostic).toContain('"enclave-runtime/primary-runtime":["failed","unknown"]');
      });

      it('does not hand successful primary preflight evidence to a different config', async () => {
        const selectedConfig = {
          ...MAIN_ACTION_STUB_CONFIG,
          containerRuntime: 'cloud-hypervisor',
          cloudHypervisor: { previewEnabled: true },
          enclaves: { enabled: true },
        } as WrapperConfig;
        const preflight = jest.fn().mockResolvedValue(undefined);
        mockedValidateOptions.validateOptions.mockReturnValueOnce(selectedConfig);
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockReturnValueOnce({
          runtime: 'cloud-hypervisor',
          preflight,
          start: jest.fn(), exec: jest.fn(), collectDiagnostics: jest.fn(), stop: jest.fn(),
        });
        mockedCliWorkflow.runMainWorkflow.mockImplementationOnce(async (_config, dependencies) => {
          await expect(dependencies.prepareEnclaves!({
            ...selectedConfig,
          })).rejects.toThrow('Cloud Hypervisor primary runtime preflight evidence is unavailable for this run');
          return 0;
        });

        const action = createMainAction(getOptionValueSource);
        await action(['echo hi'], {});

        expect(preflight).toHaveBeenCalledTimes(1);
      });

      it('hands successful primary preflight evidence to enclave preparation for the selected config', async () => {
        const selectedConfig = {
          ...MAIN_ACTION_STUB_CONFIG,
          containerRuntime: 'cloud-hypervisor',
          cloudHypervisor: { previewEnabled: true },
          enclaves: { enabled: true },
        } as WrapperConfig;
        const preflight = jest.fn().mockResolvedValue(undefined);
        mockedValidateOptions.validateOptions.mockReturnValueOnce(selectedConfig);
        mockedExternalRuntimeResolver.resolveExternalRuntimeBackend.mockReturnValueOnce({
          runtime: 'cloud-hypervisor',
          preflight,
          start: jest.fn(), exec: jest.fn(), collectDiagnostics: jest.fn(), stop: jest.fn(),
        });
        mockedEnclaveManager.prepareEnclaves.mockImplementation(async (candidate, dependencies) => {
          await dependencies?.assertCloudHypervisorPrimaryPreflight?.(candidate);
        });
        mockedCliWorkflow.runMainWorkflow.mockImplementationOnce(async (_config, dependencies) => {
          expect(preflight).toHaveBeenCalledTimes(1);
          await dependencies.prepareEnclaves!(selectedConfig);
          return 0;
        });

        try {
          await createMainAction(getOptionValueSource)(['echo hi'], {});
        } finally {
          mockedEnclaveManager.prepareEnclaves.mockResolvedValue(undefined);
        }

        expect(preflight).toHaveBeenCalledTimes(1);
        expect(mockedEnclaveManager.prepareEnclaves).toHaveBeenCalledWith(
          selectedConfig,
          expect.objectContaining({
            assertCloudHypervisorPrimaryPreflight: expect.any(Function),
          }),
        );
      });
    });
  });
});
