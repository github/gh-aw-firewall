import * as fs from 'fs';
import * as path from 'path';
import execa from 'execa';
import { getLocalDockerEnv } from './docker-host';
import { logger } from './logger';
import { WrapperConfig } from './types';

const DEFAULT_STAGING_IMAGE = 'ghcr.io/github/gh-aw-firewall/agent:latest';
const DEFAULT_DIND_WORKDIR = '/tmp/gh-aw';
const SAFE_BINARY_NAME_REGEX = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;
const DEFAULT_PRE_STAGE_DIRS = [
  '.cache',
  '.config',
  '.local',
  '.local/state',
  'home',
  'mcp-logs',
  'sandbox',
];

function isLikelyDindEnvironment(config: WrapperConfig): boolean {
  if (config.enableDind || !!config.dockerHostPathPrefix || process.env.AWF_DIND === '1') {
    return true;
  }
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost) return false;
  if (!dockerHost.startsWith('unix://')) return true;
  return dockerHost !== 'unix:///var/run/docker.sock' && dockerHost !== 'unix:///run/docker.sock';
}

function assertAbsolutePath(value: string, fieldName: string): void {
  if (!path.posix.isAbsolute(value)) {
    throw new Error(`${fieldName} must be an absolute path, got: ${value}`);
  }
}

async function preStageDindDirs(workDir: string, stagingImage: string): Promise<void> {
  assertAbsolutePath(workDir, 'dind.workDir');

  const stageDirs = DEFAULT_PRE_STAGE_DIRS
    .map((dirName) => `/awf-work/${dirName}`)
    .join(' ');
  await execa(
    'docker',
    [
      'run',
      '--rm',
      '-v',
      `${workDir}:/awf-work:rw`,
      stagingImage,
      '/bin/sh',
      '-c',
      `set -eu; mkdir -p ${stageDirs}; chmod 0777 /awf-work ${stageDirs}`,
    ],
    { env: getLocalDockerEnv() },
  );
}

async function stageEngineBinary(
  sourcePath: string,
  targetPath: string,
  stagingImage: string,
): Promise<void> {
  assertAbsolutePath(sourcePath, 'dind.stageEngineBinary.path');
  assertAbsolutePath(targetPath, 'dind.stageEngineBinary.targetPath');

  const targetDir = path.posix.dirname(targetPath);
  const targetBaseName = path.posix.basename(targetPath);
  if (!SAFE_BINARY_NAME_REGEX.test(targetBaseName)) {
    throw new Error(`dind.stageEngineBinary.targetPath has unsafe file name: ${targetPath}`);
  }

  const sourceFd = fs.openSync(sourcePath, 'r');
  let binaryBytes: Buffer;
  try {
    const sourceStat = fs.fstatSync(sourceFd);
    if (!sourceStat.isFile()) {
      throw new Error(`dind.stageEngineBinary.path is not a file: ${sourcePath}`);
    }
    binaryBytes = fs.readFileSync(sourceFd);
  } finally {
    fs.closeSync(sourceFd);
  }
  await execa(
    'docker',
    [
      'run',
      '--rm',
      '-i',
      '-v',
      `${targetDir}:/awf-target:rw`,
      stagingImage,
      '/bin/sh',
      '-c',
      `set -eu; cat > /awf-target/${targetBaseName}; chmod 0755 /awf-target/${targetBaseName}`,
    ],
    {
      env: getLocalDockerEnv(),
      input: binaryBytes,
    },
  );
}

export async function runDindBootstrap(config: WrapperConfig): Promise<void> {
  const dindConfig = config.dind;
  if (!dindConfig?.preStageDirs && !dindConfig?.stageEngineBinary) {
    return;
  }
  if (!isLikelyDindEnvironment(config)) {
    logger.debug('Skipping DinD bootstrap because no DinD signals were detected');
    return;
  }

  const stagingImage = dindConfig.stagingImage || DEFAULT_STAGING_IMAGE;
  if (dindConfig.preStageDirs) {
    const workDir = dindConfig.workDir || DEFAULT_DIND_WORKDIR;
    logger.info(`Pre-staging DinD work directory tree at ${workDir}`);
    await preStageDindDirs(workDir, stagingImage);
  }

  const stageEngineBinaryConfig = dindConfig.stageEngineBinary;
  if (stageEngineBinaryConfig?.path) {
    const targetPath = stageEngineBinaryConfig.targetPath || stageEngineBinaryConfig.path;
    logger.info(`Staging engine binary into DinD daemon filesystem: ${targetPath}`);
    await stageEngineBinary(stageEngineBinaryConfig.path, targetPath, stagingImage);
  }
}
