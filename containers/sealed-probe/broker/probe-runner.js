'use strict';

const { execFile } = require('child_process');

/**
 * Launches a single probe container.
 *
 * The argument vector is built entirely from broker configuration and
 * AWF-generated invocation identifiers. No part of it is derived from the
 * request: the caller cannot influence the image, entrypoint, runtime,
 * mounts, limits, labels, or environment.
 */

/** Extra grace beyond the probe's wall-clock budget for docker CLI overhead. */
const CLI_GRACE_MS = 5_000;

/** Maximum file size a probe may create, in bytes. */
const PROBE_MAX_FILE_BYTES = 64 * 1024 * 1024;

function runDocker(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        // Probe stdout/stderr is never returned to the caller and never
        // inspected for content; a tiny buffer is enough and caps memory.
        maxBuffer: 64 * 1024,
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
      },
      (error, stdout, stderr) => {
        resolve({
          exitCode: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          timedOut: Boolean(error && error.killed),
          stderr: typeof stderr === 'string' ? stderr.slice(0, 2000) : '',
          stdout: typeof stdout === 'string' ? stdout.slice(0, 2000) : '',
        });
      },
    );
  });
}

/**
 * Builds the fixed `docker run` argument vector for a probe.
 *
 * Exported so the sandbox flags are unit-testable without a Docker daemon.
 */
function buildProbeArgs(params) {
  const { config, runId, invocationId, containerName } = params;
  const hostInvocationDir = `${config.hostWorkDir}/${invocationId}`;

  const args = [
    'run',
    // The broker verified the image before listening. Never let a later
    // invocation ask the daemon to contact a registry if that image disappears.
    '--pull', 'never',
    '--name', containerName,
    '--label', `awf.sealed-probe.run=${runId}`,
    '--label', `awf.sealed-probe.invocation=${invocationId}`,
    // No network namespace connectivity at all: no internet, no DNS, no host
    // gateway, no bridge peers, no proxies, no other AWF container.
    '--network', 'none',
    '--read-only',
    '--user', `${config.probeUid}:${config.probeGid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--security-opt', `seccomp=${config.probeSeccompPath}`,
    '--memory', config.memoryLimit,
    '--memory-swap', config.memoryLimit,
    '--cpus', '1',
    '--pids-limit', '128',
    '--ulimit', `fsize=${PROBE_MAX_FILE_BYTES}`,
    '--ulimit', 'nofile=1024:1024',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=16m',
    '--hostname', 'probe',
    '--workdir', config.probeMountDir,
    '--env', 'HOME=/tmp',
    '--env', 'PYTHONDONTWRITEBYTECODE=1',
    '--env', 'PYTHONUNBUFFERED=1',
    // Exactly two mounts: the invocation's private writable tree (which
    // contains the repo copy and receives the output) and the submitted
    // script at a fixed read-only path. No seed parent, no other repository,
    // no Docker socket, no workspace, no credentials.
    '-v', `${hostInvocationDir}/probe:${config.probeMountDir}:rw`,
    '-v', `${hostInvocationDir}/script.py:${config.probeScriptPath}:ro`,
  ];

  if (config.dockerRuntime) {
    args.push('--runtime', config.dockerRuntime);
  }

  args.push(
    '--entrypoint', '/usr/bin/python3',
    config.probeImage,
    '-I',
    '-B',
    config.probeScriptPath,
  );

  return args;
}

/**
 * Runs the probe and force-removes its container afterwards.
 *
 * Never throws: the caller maps everything to the canonical error result.
 */
async function runProbeContainer(params) {
  const { config } = params;
  const containerName = `awf-probe-${params.invocationId}`;
  const args = buildProbeArgs({ ...params, containerName });

  try {
    return await runDocker(args, config.timeoutSeconds * 1000 + CLI_GRACE_MS);
  } finally {
    // `docker run` was not given --rm so that a timeout kill of the CLI
    // cannot leave a half-removed container; remove it unconditionally.
    await runDocker(['rm', '-f', containerName], 30_000);
  }
}

/** Verifies the probe image is present locally — probes must never pull. */
async function assertProbeImageAvailable(image) {
  const result = await runDocker(['image', 'inspect', image], 60_000);
  if (result.exitCode !== 0) {
    throw new Error(`Probe image is not available locally: ${image}`);
  }
}

module.exports = {
  PROBE_MAX_FILE_BYTES,
  buildProbeArgs,
  runProbeContainer,
  assertProbeImageAvailable,
};
