/**
 * GitHub-hosted Ubuntu x86_64 KVM runner eligibility.
 *
 * Cloud Hypervisor support targets only GitHub-hosted Ubuntu runners with
 * KVM; self-hosted and non-Ubuntu/non-x86_64 hosts are explicitly out of
 * scope. This is a separate, narrowly-scoped helper from
 * `runCloudHypervisorPreflight` so eligibility (host identity) and
 * fail-closed artifact/host-policy validation (trust/digest checks) can be
 * tested and reasoned about independently. The full live check (actually
 * opening `/dev/kvm`, resolving cgroups, etc.) remains part of preflight;
 * this only decides "is this the kind of host we support at all".
 */

export interface GithubHostedRunnerEnv {
  platform: NodeJS.Platform;
  arch: string;
  /** `GITHUB_ACTIONS` — `"true"` when running inside a GitHub Actions job. */
  githubActions?: string;
  /** `RUNNER_ENVIRONMENT` — `"github-hosted"` or `"self-hosted"`. */
  runnerEnvironment?: string;
  /** `ImageOS` — e.g. `"ubuntu24"`, set on GitHub-hosted runner images. */
  imageOs?: string;
}

export interface GithubHostedRunnerEligibility {
  eligible: boolean;
  /** Present only when `eligible` is `false`; explains which check failed. */
  reason?: string;
}

function currentEnv(): GithubHostedRunnerEnv {
  return {
    platform: process.platform,
    arch: process.arch,
    githubActions: process.env.GITHUB_ACTIONS,
    runnerEnvironment: process.env.RUNNER_ENVIRONMENT,
    imageOs: process.env.ImageOS,
  };
}

/**
 * Returns whether the current host is eligible to run Cloud Hypervisor:
 * a GitHub-hosted (not self-hosted) Ubuntu x86_64 Linux runner.
 *
 * This is a necessary-but-not-sufficient check — it does not verify KVM
 * device access, artifact trust, or pinned versions/digests. Those remain
 * `runCloudHypervisorPreflight`'s responsibility.
 */
export function evaluateGithubHostedRunnerEligibility(
  env: GithubHostedRunnerEnv = currentEnv(),
): GithubHostedRunnerEligibility {
  if (env.platform !== 'linux') {
    return { eligible: false, reason: `Cloud Hypervisor requires Linux; found ${env.platform}` };
  }
  if (env.arch !== 'x64') {
    return {
      eligible: false,
      reason: `Cloud Hypervisor supports only GitHub-hosted x86_64 runners; found Node architecture ${env.arch}`,
    };
  }
  if (env.githubActions !== 'true') {
    return {
      eligible: false,
      reason: 'Cloud Hypervisor is supported only inside GitHub Actions runs (GITHUB_ACTIONS != "true")',
    };
  }
  if (env.runnerEnvironment !== 'github-hosted') {
    return {
      eligible: false,
      reason: 'Cloud Hypervisor is supported only on GitHub-hosted runners, not self-hosted ' +
        `(RUNNER_ENVIRONMENT=${env.runnerEnvironment ?? 'unset'})`,
    };
  }
  if (!env.imageOs || !/^ubuntu/i.test(env.imageOs)) {
    return {
      eligible: false,
      reason: `Cloud Hypervisor requires a GitHub-hosted Ubuntu runner image (ImageOS=${env.imageOs ?? 'unset'})`,
    };
  }
  return { eligible: true };
}

/**
 * Throws with `evaluateGithubHostedRunnerEligibility`'s reason when the
 * current host is not an eligible GitHub-hosted Ubuntu x86_64 KVM runner.
 */
export function assertGithubHostedRunnerEligibility(
  env: GithubHostedRunnerEnv = currentEnv(),
): void {
  const result = evaluateGithubHostedRunnerEligibility(env);
  if (!result.eligible) {
    throw new Error(result.reason);
  }
}
