'use strict';

/**
 * AWF API Proxy — Shared HTTP client infrastructure.
 *
 * Centralises the HTTPS proxy agent so that every module that makes outbound
 * HTTPS requests (proxy-request.js, model-discovery.js, …) reads from the
 * same singleton rather than each constructing its own agent.
 */

const { HttpsProxyAgent } = require('https-proxy-agent');

// ── Module-level constants (read from env at load time) ───────────────────────
const HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxyAgent = HTTPS_PROXY ? new HttpsProxyAgent(HTTPS_PROXY) : undefined;

module.exports = { HTTPS_PROXY, proxyAgent };
