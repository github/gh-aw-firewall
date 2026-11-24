'use strict';

const { getRuntimeModels } = require('./runtime-model-catalog');

const AGENT_ENDPOINTS = new Set(['chat/completions', 'responses', 'messages']);

function getAutomaticModelEligibilityBlock(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.modelPickerEnabled === false) return 'model_picker_disabled';
  const type = record.capabilities?.type;
  if (typeof type === 'string' && type.trim() !== '' && type.trim().toLowerCase() !== 'chat') {
    return 'non_chat_model';
  }
  if (record.capabilities?.supports?.tool_calls === false) return 'tool_calls_unsupported';
  if (!Array.isArray(record.supportedEndpoints)) return null;
  const hasAgentEndpoint = record.supportedEndpoints.some(endpoint =>
    typeof endpoint === 'string' &&
    AGENT_ENDPOINTS.has(
      endpoint.replace(/^\/?(?:v1\/)?/, '').replace(/\/+$/, '').replace('chat_completions', 'chat/completions'),
    ));
  return hasAgentEndpoint ? null : 'no_agent_endpoint';
}

function isAutomaticModelEligible(record) {
  return getAutomaticModelEligibilityBlock(record) === null;
}

function isAutomaticModelCandidate(model, provider, runtimeCatalog) {
  const records = runtimeCatalog ? runtimeCatalog[provider] : getRuntimeModels(provider);
  const record = records?.find(entry => entry.id.toLowerCase() === model.toLowerCase());
  return isAutomaticModelEligible(record);
}

module.exports = {
  getAutomaticModelEligibilityBlock,
  isAutomaticModelEligible,
  isAutomaticModelCandidate,
};
