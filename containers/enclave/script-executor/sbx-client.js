'use strict';

const { execFile } = require('child_process');

const SBX_OUTPUT_LIMIT = 64 * 1024;
const SBX_SAFE_PATH = '/usr/local/bin:/usr/bin:/bin';

/**
 * Executes an sbx management command with the broker's narrowly provisioned
 * daemon credentials. The broker container never receives staging credentials,
 * and this environment is not forwarded to query execution inside the VM.
 *
 * Proxy variables and XDG_CONFIG_HOME are removed for parity with the primary
 * sbx management path: they can redirect daemon/credential lookup.
 */
function runSbx(args, timeoutMs) {
  const env = { ...process.env };
  delete env.DOCKER_SANDBOXES_PROXY;
  delete env.XDG_CONFIG_HOME;
  env.PATH = process.env.PATH || SBX_SAFE_PATH;

  return new Promise((resolve) => {
    execFile(
      'sbx',
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: SBX_OUTPUT_LIMIT,
        env,
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
