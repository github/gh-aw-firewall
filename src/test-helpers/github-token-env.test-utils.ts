export function githubTokenEnvNames(): readonly string[] {
  return [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GITHUB_PERSONAL_ACCESS_TOKEN',
    'COPILOT_GITHUB_TOKEN',
    'GITHUB_API_TOKEN',
    'GITHUB_PAT',
    'GH_ACCESS_TOKEN',
  ];
}

export function expectNoHostGitHubTokens(
  env: Record<string, string | undefined>,
  names: readonly string[] = githubTokenEnvNames(),
): void {
  for (const name of names) {
    expect(env).not.toHaveProperty(name);
  }
}
