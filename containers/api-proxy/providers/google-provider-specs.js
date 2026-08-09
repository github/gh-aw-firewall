'use strict';

/**
 * Declarative specs for the Google API-key–based providers (Gemini, Vertex AI).
 *
 * Centralize Google-backed provider adapter settings here and keep each wrapper
 * thin. New providers must also follow the registration and wiring checklist in ADDING-A-PROVIDER.md.
 */

const { stripGeminiKeyParam } = require('../proxy-utils');
const { GEMINI_ENV, VERTEX_ENV } = require('../provider-env-constants');

/**
 * @typedef {Object} GoogleProviderSpec
 * @property {string} name                 - Provider slug (e.g. 'gemini')
 * @property {string} label                - Human-readable name used in error messages
 * @property {number} port                 - Proxy port
 * @property {{ KEY: string, TARGET: string, BASE_PATH: string }} envConstants - Env var name constants
 * @property {string} defaultTarget        - Default upstream hostname
 * @property {string} validationPath       - URL path for the health/validation probe
 * @property {string|null} modelsPath      - URL path for models fetch, or null if unsupported
 * @property {((url: string) => string)} [transformRequestUrl] - Optional URL transformer
 */

/** @type {Record<string, GoogleProviderSpec>} */
const GOOGLE_PROVIDER_SPECS = {
  gemini: {
    name: 'gemini',
    label: 'Gemini',
    port: 10003,
    envConstants: GEMINI_ENV,
    defaultTarget: 'generativelanguage.googleapis.com',
    validationPath: '/v1beta/models',
    modelsPath: '/v1beta/models',
    /**
     * Strip Gemini SDK auth query parameters before forwarding.
     * The SDK injects ?key= (or ?apiKey=, ?api_key=) alongside the header;
     * forwarding both causes API_KEY_INVALID errors on the upstream.
     *
     * @param {string} url
     * @returns {string}
     */
    transformRequestUrl(url) {
      return stripGeminiKeyParam(url);
    },
  },
  vertex: {
    name: 'vertex',
    label: 'Vertex AI',
    port: 10004,
    envConstants: VERTEX_ENV,
    defaultTarget: 'aiplatform.googleapis.com',
    validationPath: '/v1/projects',
    modelsPath: null,
  },
};

module.exports = { GOOGLE_PROVIDER_SPECS };
