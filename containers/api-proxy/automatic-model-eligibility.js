'use strict';

const { getRuntimeModels } = require('./runtime-model-catalog');

const AGENT_ENDPOINTS = new Set(['chat/completions', 'responses', 'messages']);

function isAutomaticModelEligible(record) {
  if (record?.modelPickerEnabled === false) return false;
  const type = record?.capabilities?.type;
  if (typeof type === 'string' && type.trim() !== '' && type.trim().toLowerCase() !== 'chat') return false;
  if (record?.capabilities?.supports?.tool_calls === false) return false;
  if (!Array.isArray(record?.supportedEndpoints)) return true;
  return record.supportedEndpoints.some(endpoint =>
    typeof endpoint === 'string' &&
    AGENT_ENDPOINTS.has(
      endpoint.replace(/^\/?(?:v1\/)?/, '').replace(/\/+$/, '').replace('chat_completions', 'chat/completions'),
    ));
}

function isAutomaticModelCandidate(model, provider, runtimeCatalog) {
  const records = runtimeCatalog ? runtimeCatalog[provider] : getRuntimeModels(provider);
  const record = records?.find(entry => entry.id.toLowerCase() === model.toLowerCase());
  return isAutomaticModelEligible(record);
}

module.exports = { isAutomaticModelEligible, isAutomaticModelCandidate };
