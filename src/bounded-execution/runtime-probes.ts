import execa from 'execa';
import { getLocalDockerEnv } from '../host-env';

/** Detects whether the Docker daemon exposes a named OCI runtime. */
export type DockerRuntimeQuery = (runtimeName: string) => Promise<boolean>;

/** Detects whether the Docker daemon required by a bounded backend is reachable. */
export type DockerAvailabilityQuery = () => Promise<boolean>;

/** Detects whether the sbx primary-agent runtime is installed and authenticated. */
export type SbxAvailabilityQuery = () => Promise<boolean>;

export const defaultDockerRuntimeQuery: DockerRuntimeQuery = async (runtimeName) => {
  const result = await execa('docker', ['info', '--format', '{{json .Runtimes}}'], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  if (result.exitCode !== 0) return false;
  try {
    const runtimes = JSON.parse(result.stdout) as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(runtimes, runtimeName);
  } catch {
    return false;
  }
};

export const defaultDockerAvailabilityQuery: DockerAvailabilityQuery = async () => {
  const result = await execa('docker', ['info', '--format', '{{.ServerVersion}}'], {
    env: getLocalDockerEnv(),
    reject: false,
    timeout: 30_000,
  });
  return result.exitCode === 0;
};

/**
 * Executes the minimum host-side primary-agent capability proof for sbx: an
 * authenticated, non-mutating `sbx ls`.
 */
export const defaultSbxAvailabilityQuery: SbxAvailabilityQuery = async () => {
  try {
    const managementEnv = { ...process.env };
    delete managementEnv.DOCKER_SANDBOXES_PROXY;
    delete managementEnv.XDG_CONFIG_HOME;
    const result = await execa('sbx', ['ls'], {
      reject: false,
      timeout: 10_000,
      env: managementEnv,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
};
