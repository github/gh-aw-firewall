export const GITHUB_TOKEN_ENV_VARS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_PERSONAL_ACCESS_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'GITHUB_API_TOKEN',
  'GITHUB_PAT',
  'GH_ACCESS_TOKEN',
] as const;

export function addGithubTokenEnvVars(excludedEnvVars: Set<string>): void {
  for (const name of GITHUB_TOKEN_ENV_VARS) {
    excludedEnvVars.add(name);
  }
}

export function getGithubTokenEnvValues(): (string | undefined)[] {
  return GITHUB_TOKEN_ENV_VARS.map((name) => process.env[name]);
}

export function assertNoHostGithubTokenValue(
  value: string | undefined,
  tokenValues: readonly (string | undefined)[],
  target: string,
): void {
  if (!value) return;
  const tokens = tokenValues.filter((token): token is string => Boolean(token));
  if (tokens.some((token) => value.includes(token))) {
    throw new Error(`Refusing to pass a host GitHub token through ${target}`);
  }
}

export function enforceGithubTokenIsolation(
  environment: Record<string, string>,
  tokenValues: readonly (string | undefined)[],
  runtimeName: string,
): void {
  for (const name of GITHUB_TOKEN_ENV_VARS) {
    if (environment[name] !== '******') {
      delete environment[name];
    }
  }

  const tokens = tokenValues.filter((value): value is string => Boolean(value));
  for (const [name, value] of Object.entries(environment)) {
    assertNoHostGithubTokenValue(value, tokens, `${runtimeName} variable ${name}`);
  }
}
