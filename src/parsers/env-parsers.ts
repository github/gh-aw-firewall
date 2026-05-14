/**
 * Parses environment variables from an array of KEY=VALUE strings
 */
export function parseEnvironmentVariables(
  envVars: string[]
): { success: true; env: Record<string, string> } | { success: false; invalidVar: string } {
  const result: Record<string, string> = {};

  for (const envVar of envVars) {
    const match = envVar.match(/^([^=]+)=(.*)$/);
    if (!match) {
      return { success: false, invalidVar: envVar };
    }
    const [, key, value] = match;
    result[key] = value;
  }

  return { success: true, env: result };
}
