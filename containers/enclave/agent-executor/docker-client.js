'use strict';

const { execFile } = require('child_process');

/**
 * Executes the Docker CLI with bounded output and no inherited credentials.
 *
 * Enclave stdout/stderr are captured only so the child process cannot block on
 * a full pipe; the broker discards them and never forwards, logs, or inspects
 * them. `maxBuffer` bounds the capture so a chatty enclave cannot exhaust
 * broker memory.
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
          // Deliberately not surfaced: retained only as bounded strings so the
          // callback shape matches the enclave-script runner contract.
          stderr: typeof stderr === 'string' ? stderr.slice(0, 2000) : '',
          stdout: typeof stdout === 'string' ? stdout.slice(0, 2000) : '',
        });
      },
    );
  });
}

module.exports = { runDocker };
