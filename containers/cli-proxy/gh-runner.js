'use strict';

const { execFile } = require('child_process');

const COMMAND_TIMEOUT_MS = parseInt(process.env.AWF_CLI_PROXY_TIMEOUT_MS || '30000', 10);
const MAX_OUTPUT_BYTES = parseInt(process.env.AWF_CLI_PROXY_MAX_OUTPUT_BYTES || String(10 * 1024 * 1024), 10);

/**
 * Execute `gh` with the given args, environment, and optional base64-encoded stdin.
 *
 * Runs gh directly via execFile (no shell — prevents injection attacks).
 * Always uses the server's own cwd — the agent sends its container workspace
 * path which doesn't exist inside the cli-proxy container.
 *
 * @param {string[]} args - Arguments passed to gh (excluding 'gh' itself)
 * @param {NodeJS.ProcessEnv} childEnv - Environment for the child process
 * @param {string|null|undefined} stdin - Optional base64-encoded stdin data
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
async function runGhCommand(args, childEnv, stdin) {
  const normalizeExitCode = code => {
    if (typeof code === 'number' && Number.isFinite(code)) {
      return code;
    }
    if (typeof code === 'string') {
      const parsedCode = Number.parseInt(code, 10);
      if (!Number.isNaN(parsedCode)) {
        return parsedCode;
      }
    }
    return 1;
  };

  try {
    return await new Promise((resolve, reject) => {
      const child = execFile('gh', args, {
        cwd: process.cwd(),
        env: childEnv,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: 'utf8',
      }, (err, childStdout, childStderr) => {
        if (err && err.code === undefined && err.signal) {
          // Killed by timeout or signal
          reject(err);
          return;
        }
        resolve({
          stdout: childStdout || '',
          stderr: childStderr || '',
          exitCode: err ? normalizeExitCode(err.code) : 0,
        });
      });

      // Feed stdin if provided (base64-encoded)
      if (stdin) {
        try {
          const stdinBuf = Buffer.from(stdin, 'base64');
          child.stdin.write(stdinBuf);
        } catch {
          // Ignore stdin errors
        }
      }
      if (child.stdin) {
        child.stdin.end();
      }
    });
  } catch (err) {
    // Only expose a safe message, not a full stack trace
    const errMsg = err instanceof Error ? err.message : 'Command execution failed';
    return { stdout: '', stderr: errMsg, exitCode: 1 };
  }
}

module.exports = {
  COMMAND_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  runGhCommand,
};
