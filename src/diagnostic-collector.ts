import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { logger } from './logger';
import {
  AGENT_CONTAINER_NAME,
  SQUID_CONTAINER_NAME,
  IPTABLES_INIT_CONTAINER_NAME,
  API_PROXY_CONTAINER_NAME,
} from './constants';
import { getLocalDockerEnv } from './docker-host';
import { sanitizeDockerComposeYaml } from './compose-sanitizer';

/**
 * Collects diagnostic logs from AWF containers on failure.
 *
 * Writes the following artifacts to `${workDir}/diagnostics/` (created if absent):
 * - `<container>.log`          – stdout+stderr captured via `docker logs`
 * - `<container>.state`        – ExitCode + Error string from `docker inspect`
 * - `<container>.mounts.json`  – Mount metadata from `docker inspect` (no env vars)
 * - `docker-compose.yml`       – Generated compose file with TOKEN/KEY/SECRET values redacted
 *
 * Containers that were never started (e.g. awf-api-proxy when `--enable-api-proxy` is
 * not set) are silently skipped — `docker logs` returns a non-zero exit code and the
 * error is swallowed.
 *
 * Must be called BEFORE stopContainers() because `docker compose down -v` destroys
 * containers (and their log streams).
 *
 * @param workDir - AWF working directory (contains docker-compose.yml)
 */
export async function collectDiagnosticLogs(workDir: string): Promise<void> {
  const diagnosticsDir = path.join(workDir, 'diagnostics');
  try {
    fs.mkdirSync(diagnosticsDir, { recursive: true });
  } catch (error) {
    logger.warn('Failed to create diagnostics directory:', error);
    return;
  }

  logger.info('Collecting diagnostic logs...');

  const containers = [
    SQUID_CONTAINER_NAME,
    AGENT_CONTAINER_NAME,
    API_PROXY_CONTAINER_NAME,
    IPTABLES_INIT_CONTAINER_NAME,
  ];

  for (const container of containers) {
    try {
      const result = await execa('docker', ['logs', '--tail', '200', container], {
        reject: false,
        env: getLocalDockerEnv(),
      });
      if (result.exitCode === 0) {
        const combined = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        if (combined) {
          fs.writeFileSync(path.join(diagnosticsDir, `${container}.log`), combined + '\n');
        }
      }
    } catch {
      // Container may not exist — silently skip
    }

    try {
      const result = await execa(
        'docker',
        ['inspect', '--format', '{{.State.ExitCode}} {{.State.Error}}', container],
        { reject: false, env: getLocalDockerEnv() }
      );
      const state = result.stdout.trim();
      if (state) {
        fs.writeFileSync(path.join(diagnosticsDir, `${container}.state`), state + '\n');
      }
    } catch {
      // silently skip
    }

    try {
      const result = await execa(
        'docker',
        ['inspect', '--format', '{{json .Mounts}}', container],
        { reject: false, env: getLocalDockerEnv() }
      );
      const mounts = result.stdout.trim();
      if (mounts && mounts !== 'null') {
        fs.writeFileSync(path.join(diagnosticsDir, `${container}.mounts.json`), mounts + '\n');
      }
    } catch {
      // silently skip
    }
  }

  const composeFile = path.join(workDir, 'docker-compose.yml');
  if (fs.existsSync(composeFile)) {
    try {
      const raw = fs.readFileSync(composeFile, 'utf8');
      const sanitized = sanitizeDockerComposeYaml(raw);
      fs.writeFileSync(path.join(diagnosticsDir, 'docker-compose.yml'), sanitized);
    } catch (error) {
      logger.debug('Could not write sanitized docker-compose.yml to diagnostics:', error);
    }
  }

  logger.info(`Diagnostic logs collected at: ${diagnosticsDir}`);
}
