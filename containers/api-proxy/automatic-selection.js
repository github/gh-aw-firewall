'use strict';

/**
 * Which discovered models AWF may choose on the caller's behalf.
 *
 * Automatic selection covers every choice the caller did not name explicitly:
 * alias wildcard matches, family-version and middle-power fallback, scoped
 * auto, and automatic recovery. A model is excluded only when the provider's
 * own model list for this run says it cannot serve an agent turn; a model
 * without that evidence stays selectable, so incomplete metadata never empties
 * a catalogue. Explicitly requested models and exact alias entries are not
 * subject to this rule.
 */

const { getRuntimeModels } = require('./runtime-model-catalog');

const AGENT_ENDPOINTS = new Set(['chat/completions', 'responses', 'messages']);

function normalizeEndpoint(endpoint) {
  const path = endpoint.replace(/^ws:/i, '').replace(/^\/?(?:v1\/)?/, '').replace(/\/+$/, '');
  return path === 'chat_completions' ? 'chat/completions' : path;
}

/**
 * Why a provider model record cannot be selected automatically, or null when
 * it can.
 *
 * @param {object|null|undefined} record - Runtime model record from provider discovery
 * @returns {'model_picker_disabled'|'no_agent_endpoint'|null}
 */
function getAutomaticSelectionBlock(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.modelPickerEnabled === false) return 'model_picker_disabled';
  const endpoints = Array.isArray(record.supportedEndpoints)
    ? record.supportedEndpoints.filter(endpoint => typeof endpoint === 'string')
    : [];
  if (endpoints.length > 0 && !endpoints.some(endpoint => AGENT_ENDPOINTS.has(normalizeEndpoint(endpoint)))) {
    return 'no_agent_endpoint';
  }
  return null;
}

/**
 * Whether a discovered model ID may be chosen automatically on a provider.
 *
 * @param {string} model - Provider model ID
 * @param {string} provider - Provider name (e.g. "copilot")
 * @returns {boolean}
 */
function isAutomaticallySelectable(model, provider) {
  if (typeof model !== 'string') return true;
  const id = model.toLowerCase();
  const record = (getRuntimeModels(provider) || []).find(entry => entry?.id?.toLowerCase() === id);
  return getAutomaticSelectionBlock(record) === null;
}

module.exports = { getAutomaticSelectionBlock, isAutomaticallySelectable };
