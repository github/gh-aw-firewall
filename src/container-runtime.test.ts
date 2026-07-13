import { resolveDockerRuntime, runtimeNeedsStaticDns, runtimeUsesComposeAgent } from './container-runtime';
import { sanitizeEnvForSbx } from './sbx-manager';

describe('container-runtime', () => {
  describe('resolveDockerRuntime', () => {
    it('translates gvisor to runsc', () => {
      expect(resolveDockerRuntime('gvisor')).toBe('runsc');
    });

    it('returns undefined for sbx (no OCI runtime)', () => {
      expect(resolveDockerRuntime('sbx')).toBeUndefined();
    });

    it('passes through unknown runtime names unchanged', () => {
      expect(resolveDockerRuntime('kata')).toBe('kata');
      expect(resolveDockerRuntime('runsc')).toBe('runsc');
      expect(resolveDockerRuntime('custom-runtime')).toBe('custom-runtime');
    });
  });

  describe('runtimeNeedsStaticDns', () => {
    it('returns true for gvisor', () => {
      expect(runtimeNeedsStaticDns('gvisor')).toBe(true);
    });

    it('returns false for sbx', () => {
      expect(runtimeNeedsStaticDns('sbx')).toBe(false);
    });

    it('returns false for unknown runtimes', () => {
      expect(runtimeNeedsStaticDns('kata')).toBe(false);
      expect(runtimeNeedsStaticDns('runsc')).toBe(false);
    });

    it('returns false for undefined/empty', () => {
      expect(runtimeNeedsStaticDns(undefined)).toBe(false);
      expect(runtimeNeedsStaticDns('')).toBe(false);
    });
  });

  describe('runtimeUsesComposeAgent', () => {
    it('returns true when no runtime is configured', () => {
      expect(runtimeUsesComposeAgent(undefined)).toBe(true);
    });

    it('returns true for compose-model runtimes (gvisor)', () => {
      expect(runtimeUsesComposeAgent('gvisor')).toBe(true);
    });

    it('returns false for microvm-model runtimes (sbx)', () => {
      expect(runtimeUsesComposeAgent('sbx')).toBe(false);
    });

    it('returns true for unknown runtimes (assumed compose)', () => {
      expect(runtimeUsesComposeAgent('kata')).toBe(true);
      expect(runtimeUsesComposeAgent('runsc')).toBe(true);
    });
  });
});

describe('sanitizeEnvForSbx', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore process.env
    for (const key of Object.keys(process.env)) {
      if (!(key in origEnv)) delete process.env[key];
    }
    Object.assign(process.env, origEnv);
  });

  it('strips env vars matching secret patterns', () => {
    process.env.COPILOT_GITHUB_TOKEN = 'ghp_secret123';
    process.env.GH_AW_GITHUB_TOKEN = 'ghp_secret456';
    process.env.GITHUB_MCP_SERVER_TOKEN = 'ghp_secret789';
    process.env.DOCKER_PAT = 'dkr_pat_abc';
    process.env.DOCKER_USERNAME = 'myuser';
    process.env.MY_API_KEY = 'key123';
    process.env.AWS_SECRET_ACCESS_KEY = 'awskey';
    process.env.SAFE_VARIABLE = 'keep-this';

    const result = sanitizeEnvForSbx();

    expect(result.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(result.GH_AW_GITHUB_TOKEN).toBeUndefined();
    expect(result.GITHUB_MCP_SERVER_TOKEN).toBeUndefined();
    expect(result.DOCKER_PAT).toBeUndefined();
    expect(result.DOCKER_USERNAME).toBeUndefined();
    expect(result.MY_API_KEY).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.SAFE_VARIABLE).toBe('keep-this');
  });

  it('allows overrides to pass through', () => {
    const result = sanitizeEnvForSbx({ DOCKER_SANDBOXES_PROXY: 'http://172.30.0.10:3128' });
    expect(result.DOCKER_SANDBOXES_PROXY).toBe('http://172.30.0.10:3128');
  });

  it('preserves PATH and HOME', () => {
    const result = sanitizeEnvForSbx();
    expect(result.PATH).toBeDefined();
    expect(result.HOME).toBeDefined();
  });
});
