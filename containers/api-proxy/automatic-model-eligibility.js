'use strict';

const { getRuntimeModels } = require('./runtime-model-catalog');

const AGENT_ENDPOINTS = new Set(['chat/completions', 'responses', 'messages']);

function isAutomaticModelEligible(record) {
  if (record?.modelPickerEnabled === false) return false;
  if (!Array.isArray(record?.supportedEndpoints)) return true;
  return record.supportedEndpoints.some(endpoint =>
    typeof endpoint === 'string' &&
    AGENT_ENDPOINTS.has(endpoint.replace(/^\/?(?:v1\/)?/, '').replace('chat_completions', 'chat/completions')));
}

function isAutomaticModelCandidate(model, provider, runtimeCatalog) {
  const records = runtimeCatalog ? runtimeCatalog[provider] : getRuntimeModels(provider);
  const record = records?.find(entry => entry.id.toLowerCase() === model.toLowerCase());
  return isAutomaticModelEligible(record);
}

module.exports = { isAutomaticModelEligible, isAutomaticModelCandidate };
