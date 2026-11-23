'use strict';

const CHILD_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'TZ',
  'GH_HOST',
  'GH_REPO',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GITHUB_SERVER_URL',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'GIT_SSL_CAINFO',
  'GH_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NO_PROXY',
  'no_proxy',
]);

const FORCED_CHILD_ENV = Object.freeze({
  GH_PROMPT_DISABLED: '1',
  GH_PAGER: 'cat',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
  GH_EDITOR: 'false',
  GIT_EDITOR: 'false',
  EDITOR: 'false',
  VISUAL: 'false',
  GH_BROWSER: 'false',
  BROWSER: 'false',
});

/**
 * Build the environment object for a subprocess from server-owned values only.
 *
 * @param {string|undefined} capability - Enclave invocation capability
 * @returns {NodeJS.ProcessEnv} The merged environment for the child process
 */
function buildExecEnv(capability) {
  const childEnv = { ...FORCED_CHILD_ENV };
  for (const key of CHILD_ENV_KEYS) {
    if (typeof process.env[key] === 'string') childEnv[key] = process.env[key];
  }
  if (process.env.AWF_CLI_PROXY_MODE === 'enclave') {
    for (const key of [
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_ENTERPRISE_TOKEN',
      'GH_ENTERPRISE_TOKEN',
    ]) delete childEnv[key];
    if (typeof capability !== 'string') {
      throw new Error('missing enclave invocation capability');
    }
    // GH_HOST is a private alias, so gh classifies it as an enterprise host and
    // reads GH_ENTERPRISE_TOKEN rather than GH_TOKEN.
    childEnv.GH_ENTERPRISE_TOKEN = capability;
  }
  return childEnv;
}

module.exports = {
  CHILD_ENV_KEYS,
  FORCED_CHILD_ENV,
  buildExecEnv,
};
