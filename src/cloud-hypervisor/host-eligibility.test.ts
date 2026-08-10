import {
  assertGithubHostedRunnerEligibility,
  evaluateGithubHostedRunnerEligibility,
  type GithubHostedRunnerEnv,
} from './host-eligibility';

function env(overrides: Partial<GithubHostedRunnerEnv> = {}): GithubHostedRunnerEnv {
  return {
    platform: 'linux',
    arch: 'x64',
    githubActions: 'true',
    runnerEnvironment: 'github-hosted',
    imageOs: 'ubuntu24',
    ...overrides,
  };
}

describe('GitHub-hosted Ubuntu KVM runner eligibility', () => {
  it('accepts a GitHub-hosted Ubuntu x86_64 runner', () => {
    expect(evaluateGithubHostedRunnerEligibility(env())).toEqual({ eligible: true });
    expect(() => assertGithubHostedRunnerEligibility(env())).not.toThrow();
  });

  it('rejects non-Linux hosts', () => {
    expect(evaluateGithubHostedRunnerEligibility(env({ platform: 'darwin' })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/requires Linux/) });
  });

  it('rejects non-x86_64 architectures', () => {
    expect(evaluateGithubHostedRunnerEligibility(env({ arch: 'arm64' })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/x86_64 runners/) });
  });

  it('rejects hosts outside GitHub Actions', () => {
    expect(evaluateGithubHostedRunnerEligibility(env({ githubActions: undefined })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/GitHub Actions runs/) });
  });

  it('rejects self-hosted runners', () => {
    expect(evaluateGithubHostedRunnerEligibility(env({ runnerEnvironment: 'self-hosted' })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/not self-hosted/) });
  });

  it('rejects non-Ubuntu runner images', () => {
    expect(evaluateGithubHostedRunnerEligibility(env({ imageOs: 'windows2022' })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/Ubuntu runner image/) });
    expect(evaluateGithubHostedRunnerEligibility(env({ imageOs: undefined })))
      .toEqual({ eligible: false, reason: expect.stringMatching(/Ubuntu runner image/) });
  });

  it('throws the evaluated reason via the assertion helper', () => {
    expect(() => assertGithubHostedRunnerEligibility(env({ platform: 'darwin' })))
      .toThrow(/requires Linux/);
  });

  it('defaults to reading the live process environment', () => {
    const originalEnv = { ...process.env };
    const originalPlatform = process.platform;
    const originalArch = process.arch;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    Object.defineProperty(process, 'arch', { value: 'x64' });
    process.env.GITHUB_ACTIONS = 'true';
    process.env.RUNNER_ENVIRONMENT = 'github-hosted';
    process.env.ImageOS = 'ubuntu24';
    try {
      expect(evaluateGithubHostedRunnerEligibility().eligible).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      Object.defineProperty(process, 'arch', { value: originalArch });
      process.env = originalEnv;
    }
  });
});
