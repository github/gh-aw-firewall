import { generateDockerCompose, WrapperConfig, baseConfig, mockNetworkConfig, useTempWorkDir } from './service-test-setup.test-utils';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// Mock execa module
// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

let mockConfig: WrapperConfig;

describe('agent environment: runtime', () => {
  useTempWorkDir(
    baseConfig,
    (config) => {
      mockConfig = config;
    },
    () => mockConfig
  );

  it('should set NO_COLOR=1 when tty is false (default)', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.NO_COLOR).toBe('1');
    expect(env.FORCE_COLOR).toBeUndefined();
    expect(env.COLUMNS).toBeUndefined();
  });

  it('should set FORCE_COLOR, TERM, and COLUMNS when tty is true', () => {
    const ttyConfig = { ...mockConfig, tty: true };
    const result = generateDockerCompose(ttyConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const env = agent.environment as Record<string, string>;

    expect(env.FORCE_COLOR).toBe('1');
    expect(env.TERM).toBe('xterm-256color');
    expect(env.COLUMNS).toBe('120');
    expect(env.NO_COLOR).toBeUndefined();
  });

  it('should set AWF_CHROOT_ENABLED environment variable', () => {
    const result = generateDockerCompose(mockConfig, mockNetworkConfig);
    const agent = result.services.agent;
    const environment = agent.environment as Record<string, string>;

    expect(environment.AWF_CHROOT_ENABLED).toBe('true');
  });

  it('should set AWF_REQUIRE_NODE when running Copilot CLI command', () => {
    const result = generateDockerCompose(
      { ...mockConfig, agentCommand: 'copilot --version' },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_REQUIRE_NODE).toBe('1');
  });

  it('should set AWF_REQUIRE_NODE when copilotGithubToken is present', () => {
    const result = generateDockerCompose(
      { ...mockConfig, agentCommand: 'echo test', copilotGithubToken: 'ghu_test_token' },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_REQUIRE_NODE).toBe('1');
  });

  it('should set AWF_REQUIRE_NODE when COPILOT_PROVIDER_API_KEY is present (direct-BYOK)', () => {
    const result = generateDockerCompose(
      {
        ...mockConfig,
        agentCommand: './my-copilot-wrapper.sh',
        copilotProviderApiKey: 'azure-byok-key',
      },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_REQUIRE_NODE).toBe('1');
  });

  it('should not set AWF_REQUIRE_NODE for non-Copilot commands', () => {
    const result = generateDockerCompose(
      { ...mockConfig, agentCommand: 'echo test' },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_REQUIRE_NODE).toBeUndefined();
  });

  it('should set AWF_PREFLIGHT_BINARY=codex when running codex command', () => {
    const result = generateDockerCompose(
      { ...mockConfig, agentCommand: 'codex --version' },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_PREFLIGHT_BINARY).toBe('codex');
  });

  it('should not set AWF_PREFLIGHT_BINARY for non-codex commands', () => {
    const result = generateDockerCompose(
      { ...mockConfig, agentCommand: 'echo test' },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_PREFLIGHT_BINARY).toBeUndefined();
  });

  it('should set AWF_STAGED_RUNNER_BINARY_NAME in /tmp docker-host-path-prefix mode', () => {
    const result = generateDockerCompose(
      {
        ...mockConfig,
        dockerHostPathPrefix: '/tmp/gh-aw',
        agentCommand: 'copilot --version',
      },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_STAGED_RUNNER_BINARY_NAME).toBe('copilot');
  });

  it('should pass GOROOT, CARGO_HOME, RUSTUP_HOME, JAVA_HOME, DOTNET_ROOT, BUN_INSTALL to container when env vars are set', () => {
    const originalGoroot = process.env.GOROOT;
    const originalCargoHome = process.env.CARGO_HOME;
    const originalRustupHome = process.env.RUSTUP_HOME;
    const originalJavaHome = process.env.JAVA_HOME;
    const originalDotnetRoot = process.env.DOTNET_ROOT;
    const originalBunInstall = process.env.BUN_INSTALL;

    process.env.GOROOT = '/usr/local/go';
    process.env.CARGO_HOME = '/home/user/.cargo';
    process.env.RUSTUP_HOME = '/home/user/.rustup';
    process.env.JAVA_HOME = '/usr/lib/jvm/java-17';
    process.env.DOTNET_ROOT = '/usr/lib/dotnet';
    process.env.BUN_INSTALL = '/home/user/.bun';

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_GOROOT).toBe('/usr/local/go');
      expect(environment.AWF_CARGO_HOME).toBe('/home/user/.cargo');
      expect(environment.AWF_RUSTUP_HOME).toBe('/home/user/.rustup');
      expect(environment.AWF_JAVA_HOME).toBe('/usr/lib/jvm/java-17');
      expect(environment.AWF_DOTNET_ROOT).toBe('/usr/lib/dotnet');
      expect(environment.AWF_BUN_INSTALL).toBe('/home/user/.bun');
    } finally {
      // Restore original values
      if (originalGoroot !== undefined) {
        process.env.GOROOT = originalGoroot;
      } else {
        delete process.env.GOROOT;
      }
      if (originalCargoHome !== undefined) {
        process.env.CARGO_HOME = originalCargoHome;
      } else {
        delete process.env.CARGO_HOME;
      }
      if (originalRustupHome !== undefined) {
        process.env.RUSTUP_HOME = originalRustupHome;
      } else {
        delete process.env.RUSTUP_HOME;
      }
      if (originalJavaHome !== undefined) {
        process.env.JAVA_HOME = originalJavaHome;
      } else {
        delete process.env.JAVA_HOME;
      }
      if (originalDotnetRoot !== undefined) {
        process.env.DOTNET_ROOT = originalDotnetRoot;
      } else {
        delete process.env.DOTNET_ROOT;
      }
      if (originalBunInstall !== undefined) {
        process.env.BUN_INSTALL = originalBunInstall;
      } else {
        delete process.env.BUN_INSTALL;
      }
    }
  });

  it('should NOT set AWF_BUN_INSTALL when BUN_INSTALL is not in environment', () => {
    const originalBunInstall = process.env.BUN_INSTALL;
    delete process.env.BUN_INSTALL;

    try {
      const result = generateDockerCompose(mockConfig, mockNetworkConfig);
      const agent = result.services.agent;
      const environment = agent.environment as Record<string, string>;

      expect(environment.AWF_BUN_INSTALL).toBeUndefined();
    } finally {
      if (originalBunInstall !== undefined) {
        process.env.BUN_INSTALL = originalBunInstall;
      }
    }
  });

  it('should set AWF_WORKDIR environment variable', () => {
    const configWithWorkDir = {
      ...mockConfig,
      containerWorkDir: '/workspace/project'
    };
    const result = generateDockerCompose(configWithWorkDir, mockNetworkConfig);
    const agent = result.services.agent;
    const environment = agent.environment as Record<string, string>;

    expect(environment.AWF_WORKDIR).toBe('/workspace/project');
  });

  it('should set chroot identity override environment variables when configured', () => {
    const result = generateDockerCompose(
      {
        ...mockConfig,
        chrootIdentity: {
          home: '/tmp/gh-aw/home',
          user: 'runner',
          uid: 1001,
          gid: 1001,
        },
      },
      mockNetworkConfig,
    );
    const environment = result.services.agent.environment as Record<string, string>;

    expect(environment.AWF_CHROOT_IDENTITY_HOME).toBe('/tmp/gh-aw/home');
    expect(environment.AWF_CHROOT_IDENTITY_USER).toBe('runner');
    expect(environment.AWF_CHROOT_IDENTITY_UID).toBe('1001');
    expect(environment.AWF_CHROOT_IDENTITY_GID).toBe('1001');
  });
});
