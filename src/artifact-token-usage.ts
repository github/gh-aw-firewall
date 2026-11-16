import * as fs from 'fs';
import * as path from 'path';
import { logger } from './logger';

/** File name the api-proxy sidecar writes per-request token usage records to. */
const TOKEN_USAGE_LOG_FILE = 'token-usage.jsonl';

/**
 * Environment variable exported via `$GITHUB_ENV` with the absolute,
 * runner-visible path of the preserved `token-usage.jsonl`.
 *
 * The location depends on `--proxy-logs-dir`, the work directory, and
 * `--docker-host-path-prefix` translation (for example `${RUNNER_TEMP}/gh-aw/...`
 * under `runner.topology: arc-dind`), so later workflow steps should read this
 * variable instead of hardcoding a `/tmp/gh-aw/...` path.
 */
const TOKEN_USAGE_LOG_ENV_VAR = 'AWF_TOKEN_USAGE_LOG';

export function resolveTokenLogSubdir(tokenLogDir?: string): string | undefined {
  const relativePath = path.relative('/var/log/api-proxy', tokenLogDir || '/var/log/api-proxy');
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return undefined;
  }
  return relativePath === '.' ? '' : relativePath;
}

/**
 * Logs the final runner-visible token-usage log path and, inside GitHub
 * Actions, exports it as {@link TOKEN_USAGE_LOG_ENV_VAR} for subsequent steps.
 * Best-effort: never throws.
 */
export function publishTokenUsageLogPath(apiProxyLogsDir: string, tokenLogSubdir: string): void {
  const tokenUsageLog = path.join(apiProxyLogsDir, tokenLogSubdir, TOKEN_USAGE_LOG_FILE);
  if (!fs.existsSync(tokenUsageLog)) return;
  logger.info(`Token usage log available at: ${tokenUsageLog}`);

  const githubEnvFile = process.env.GITHUB_ENV;
  if (!githubEnvFile) return;
  // A newline would let the value inject additional $GITHUB_ENV entries.
  if (/[\r\n]/.test(tokenUsageLog)) {
    logger.debug(`Not exporting ${TOKEN_USAGE_LOG_ENV_VAR}: path contains a newline`);
    return;
  }
  try {
    fs.appendFileSync(githubEnvFile, `${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsageLog}\n`);
    logger.debug(`Exported ${TOKEN_USAGE_LOG_ENV_VAR}=${tokenUsageLog} to $GITHUB_ENV`);
  } catch (error) {
    logger.debug(`Could not export ${TOKEN_USAGE_LOG_ENV_VAR} to $GITHUB_ENV:`, error);
  }
}
