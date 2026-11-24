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
const { isAutomaticModelEligible } = require('./automatic-model-eligibility');

/**
 * Why a provider model record cannot be selected automatically, or null when
 * it can.
 *
 * @param {object|null|undefined} record - Runtime model record from provider discovery
 * @returns {'model_picker_disabled'|'non_chat_model'|'tool_calls_unsupported'|'no_agent_endpoint'|null}
 */
function getAutomaticSelectionBlock(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.modelPickerEnabled === false) return 'model_picker_disabled';
  const type = record.capabilities?.type;
  if (typeof type === 'string' && type.trim() !== '' && type.trim().toLowerCase() !== 'chat') {
    return 'non_chat_model';
  }
  if (record.capabilities?.supports?.tool_calls === false) return 'tool_calls_unsupported';
  return isAutomaticModelEligible(record) ? null : 'no_agent_endpoint';
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
