import { generateDockerCompose, mockNetworkConfig, useAgentVolumesTestConfig, withEnv } from './service-test-setup.test-utils';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Create mock functions (must remain per-file — jest.mock() is hoisted before imports)

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const { getConfig } = useAgentVolumesTestConfig();

describe('agent service', () => {
  it('should mount Rust toolchain, Node/npm caches, and CLI state directories', () => {
    const result = generateDockerCompose(getConfig(), mockNetworkConfig);
    const agent = result.services.agent;
    const volumes = agent.volumes as string[];

    const homeDir = process.env.HOME || '/root';
    // Rust toolchain directories
    expect(volumes).toContain(`${homeDir}/.cargo:/host${homeDir}/.cargo:rw`);
    expect(volumes).toContain(`${homeDir}/.rustup:/host${homeDir}/.rustup:rw`);
    // npm cache
    expect(volumes).toContain(`${homeDir}/.npm:/host${homeDir}/.npm:rw`);
    // nvm-managed Node.js cache/installations
    expect(volumes).toContain(`${homeDir}/.nvm:/host${homeDir}/.nvm:rw`);
    // CLI state directories
    expect(volumes).toContain(`${homeDir}/.claude:/host${homeDir}/.claude:rw`);
    expect(volumes).toContain(`${homeDir}/.anthropic:/host${homeDir}/.anthropic:rw`);
    // ~/.gemini is NOT mounted when geminiApiKey is absent (fixes suspicious log in Copilot runs)
    expect(volumes).not.toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
    // ~/.copilot is only mounted if it already exists on the host
    if (fs.existsSync(path.join(homeDir, '.copilot'))) {
      expect(volumes).toContain(`${homeDir}/.copilot:/host${homeDir}/.copilot:rw`);
    }
    // session-state and logs are always overlaid from AWF workDir
    expect(volumes).toContain(`${getConfig().workDir}/agent-session-state:/host${homeDir}/.copilot/session-state:rw`);
    expect(volumes).toContain(`${getConfig().workDir}/agent-logs:/host${homeDir}/.copilot/logs:rw`);
  });

  it('should mount ~/.gemini when geminiApiKey is configured', () => {
    const configWithGemini = { ...getConfig(), geminiApiKey: 'AIza-test-gemini-key' };
    const result = generateDockerCompose(configWithGemini, mockNetworkConfig);
    const volumes = result.services.agent.volumes as string[];

    const homeDir = process.env.HOME || '/root';
    expect(volumes).toContain(`${homeDir}/.gemini:/host${homeDir}/.gemini:rw`);
  });

  it('should mount container.runnerToolCachePath when it points to a real directory', () => {
    const toolcacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: undefined }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: toolcacheDir,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${toolcacheDir}:/host${toolcacheDir}:ro`);
      });
    } finally {
      fs.rmSync(toolcacheDir, { recursive: true, force: true });
    }
  });

  it('should mount RUNNER_TOOL_CACHE when it is set to a real directory', () => {
    const runnerToolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runner-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });
    } finally {
      fs.rmSync(runnerToolCacheDir, { recursive: true, force: true });
    }
  });

  it('should prefer container.runnerToolCachePath over RUNNER_TOOL_CACHE', () => {
    const configuredDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-configured-toolcache-'));
    const runnerToolCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-runner-toolcache-'));

    try {
      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose(getConfig(), mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });

      withEnv({ RUNNER_TOOL_CACHE: runnerToolCacheDir }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: configuredDir,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).toContain(`${configuredDir}:/host${configuredDir}:ro`);
        expect(volumes).not.toContain(`${runnerToolCacheDir}:/host${runnerToolCacheDir}:ro`);
      });
    } finally {
      fs.rmSync(configuredDir, { recursive: true, force: true });
      fs.rmSync(runnerToolCacheDir, { recursive: true, force: true });
    }
  });

  it('should not mount container.runnerToolCachePath when it is a symlink', () => {
    const symlinkTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-target-'));
    const symlinkPath = path.join(os.tmpdir(), `awf-toolcache-link-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {
      fs.symlinkSync(symlinkTarget, symlinkPath);

      withEnv({ RUNNER_TOOL_CACHE: undefined }, () => {
        const result = generateDockerCompose({
          ...getConfig(),
          runnerToolCachePath: symlinkPath,
        }, mockNetworkConfig);
        const volumes = result.services.agent.volumes as string[];

        expect(volumes).not.toContain(`${symlinkPath}:/host${symlinkPath}:ro`);
      });
    } finally {
      if (fs.existsSync(symlinkPath)) {
        fs.unlinkSync(symlinkPath);
      }
      fs.rmSync(symlinkTarget, { recursive: true, force: true });
    }
  });
});
