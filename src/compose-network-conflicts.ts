import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import * as yaml from 'js-yaml';
import { logger } from './logger';
import { getLocalDockerEnv } from './docker-host';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

/**
 * Replicates Docker Compose's default project-name derivation: the base name of
 * the project directory, lowercased, with every character outside `[a-z0-9_-]`
 * removed and leading separators stripped. `COMPOSE_PROJECT_NAME` wins when set.
 */
function resolveComposeProjectName(workDir: string): string {
  const fromEnv = process.env.COMPOSE_PROJECT_NAME;
  if (fromEnv && fromEnv.trim()) {
    return fromEnv.trim();
  }
  return path
    .basename(path.resolve(workDir))
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .replace(/^[_-]+/, '');
}

/**
 * Returns the fixed (non project-scoped) network names declared by the compose
 * file. Only networks that pin `name:` and are not `external: true` can collide
 * with a leftover network from a previous run — Compose's default names are
 * already prefixed with the (timestamped) project name, and external networks
 * are intentionally reused.
 */
function getFixedComposeNetworkNames(workDir: string): string[] {
  const composePath = path.join(workDir, 'docker-compose.yml');
  let compose: any;
  try {
    compose = yaml.load(fs.readFileSync(composePath, 'utf8'));
  } catch {
    // No (or unreadable) compose file — nothing to reconcile.
    return [];
  }

  const networks = compose?.networks;
  if (!networks || typeof networks !== 'object') {
    return [];
  }

  const names: string[] = [];
  for (const definition of Object.values(networks) as any[]) {
    if (!definition || typeof definition !== 'object') continue;
    if (definition.external) continue;
    if (typeof definition.name === 'string' && definition.name) {
      names.push(definition.name);
    }
  }
  return [...new Set(names)];
}

async function inspectNetwork(name: string, format: string): Promise<string | null> {
  const result = await execa('docker', ['network', 'inspect', name, '--format', format], {
    reject: false,
    env: getLocalDockerEnv(),
  });
  return result.exitCode === 0 ? result.stdout : null;
}

async function inspectContainer(id: string, format: string): Promise<string | null> {
  const result = await execa('docker', ['inspect', id, '--format', format], {
    reject: false,
    env: getLocalDockerEnv(),
  });
  return result.exitCode === 0 ? result.stdout : null;
}

async function disconnectStaleContainers(name: string, projectName: string): Promise<void> {
  const raw = await inspectNetwork(name, '{{json .Containers}}');
  if (!raw) return;
  let containers: Record<string, unknown>;
  try {
    containers = JSON.parse(raw) || {};
  } catch {
    return;
  }
  for (const containerId of Object.keys(containers)) {
    const container = await inspectContainer(containerId, '{{json .Config.Labels}}\t{{.State.Status}}');
    if (!container) continue;
    const [labelsJson, status] = container.split('\t');
    let labels: Record<string, unknown> | null;
    try {
      labels = JSON.parse(labelsJson) || {};
    } catch {
      continue;
    }
    if (labels?.[COMPOSE_PROJECT_LABEL] !== projectName || status.trim() === 'running') {
      continue;
    }
    await execa('docker', ['network', 'disconnect', '-f', name, containerId], {
      reject: false,
      env: getLocalDockerEnv(),
    });
  }
}

/**
 * Removes Docker networks whose fixed names are declared by the generated
 * compose file but which were created by a different (or no) Compose project.
 *
 * Without this, Compose refuses to start with
 * `a network with name awf-net exists but was not created for project "awf-<ts>"`
 * whenever a previous AWF run was killed or timed out before its network was
 * removed. Failures are logged and ignored so that Compose still produces its
 * own diagnostics if the network genuinely cannot be reclaimed.
 */
export async function removeConflictingComposeNetworks(workDir: string): Promise<void> {
  const names = getFixedComposeNetworkNames(workDir);
  if (names.length === 0) {
    return;
  }

  const projectName = resolveComposeProjectName(workDir);

  for (const name of names) {
    try {
      const labels = await inspectNetwork(name, `{{index .Labels "${COMPOSE_PROJECT_LABEL}"}}`);
      if (labels === null) {
        // Network does not exist — nothing to reconcile.
        continue;
      }
      if (labels.trim() === projectName) {
        // Already owned by this run's project; Compose will reuse it.
        continue;
      }

      logger.warn(
        `Removing orphaned Docker network '${name}' left over from a previous run ` +
        `(owned by project '${labels.trim() || '<none>'}', current project '${projectName}')`
      );
      let removal = await execa('docker', ['network', 'rm', name], {
        reject: false,
        env: getLocalDockerEnv(),
      });
      if (removal.exitCode !== 0) {
        // The network still has (possibly stale) endpoints attached. Detach them
        // and retry once — leftover endpoints from killed containers otherwise
        // pin the network forever.
        await disconnectStaleContainers(name, labels.trim());
        removal = await execa('docker', ['network', 'rm', name], {
          reject: false,
          env: getLocalDockerEnv(),
        });
      }
      if (removal.exitCode !== 0) {
        logger.warn(
          `Could not remove orphaned Docker network '${name}': ${removal.stderr || removal.stdout}`
        );
      }
    } catch (error) {
      logger.debug(`Orphaned network reconciliation for '${name}' failed:`, error);
    }
  }
}

/** @internal Exposed only for unit tests — not part of the public API. */
// ts-prune-ignore-next
export const composeNetworkConflictTestHelpers = {
  resolveComposeProjectName,
  getFixedComposeNetworkNames,
};
