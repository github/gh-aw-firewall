'use strict';

const { execFile } = require('child_process');

/**
 * Executes the Docker CLI with bounded output and no inherited credentials.
 */
function runDocker(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'docker',
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
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

module.exports = { runDocker };
