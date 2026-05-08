'use strict';

/**
 * Shared GitHub Actions OIDC token minting utility.
 *
 * Requests a GitHub-issued JWT from the Actions runtime for use in
 * federated identity exchanges with cloud providers (Azure, AWS, GCP).
 */

const https = require('https');
const http = require('http');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * Mint a GitHub OIDC token with the specified audience.
 *
 * @param {Object} config
 * @param {string} config.requestUrl  - ACTIONS_ID_TOKEN_REQUEST_URL
 * @param {string} config.requestToken - ACTIONS_ID_TOKEN_REQUEST_TOKEN
 * @param {string} config.audience    - Audience claim for the OIDC token
 * @returns {Promise<string>} The GitHub-issued JWT
 */
async function mintGitHubOidcToken({ requestUrl, requestToken, audience }) {
  const url = new URL(requestUrl);
  url.searchParams.set('audience', audience);

  const response = await httpGet(url.toString(), {
    'Authorization': `Bearer ${requestToken}`,
    'Accept': 'application/json',
  });

  if (response.statusCode !== 200) {
    throw new Error(`GitHub OIDC token request failed: HTTP ${response.statusCode} — ${response.body}`);
  }

  const data = JSON.parse(response.body);
  if (!data.value) {
    throw new Error('GitHub OIDC response missing "value" field');
  }
  return data.value;
}

/**
 * HTTP GET helper with proxy support.
 * @param {string} url
 * @param {Record<string, string>} headers
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpGet(url, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers,
      agent: getProxyAgent(parsedUrl),
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('GitHub OIDC request timeout')); });
  });
}

/**
 * HTTP POST helper with proxy support.
 * @param {string} url
 * @param {string} body
 * @param {Record<string, string>} headers
 * @returns {Promise<{statusCode: number, body: string}>}
 */
function httpPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const options = {
      method: 'POST',
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      agent: getProxyAgent(parsedUrl),
    };

    const mod = parsedUrl.protocol === 'https:' ? https : http;
    const req = mod.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => resolve({ statusCode: res.statusCode, body: responseBody }));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => { req.destroy(new Error('Token exchange timeout')); });
    req.write(body);
    req.end();
  });
}

/**
 * Build proxy agent from env vars when configured.
 * @param {URL} parsedUrl
 * @returns {import('http').Agent|undefined}
 */
function getProxyAgent(parsedUrl) {
  const proxyUrl = parsedUrl.protocol === 'https:'
    ? (process.env.HTTPS_PROXY || process.env.HTTP_PROXY)
    : (process.env.HTTP_PROXY || process.env.HTTPS_PROXY);
  return proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
}

module.exports = { mintGitHubOidcToken, httpGet, httpPost, getProxyAgent };
