'use strict';

const { execFile } = require('child_process');

const SBX_OUTPUT_LIMIT = 64 * 1024;
const SBX_SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Executes the sbx CLI without forwarding host credentials or proxy settings.
 *
 * A future supported deployment must provide daemon transport separately at
 * the container boundary. Query invocations never receive this environment.
 */
function runSbx(args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'sbx',
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: SBX_OUTPUT_LIMIT,
        env: { PATH: process.env.PATH || SBX_SAFE_PATH },
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

module.exports = { runSbx };
