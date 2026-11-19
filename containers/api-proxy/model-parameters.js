/**
 * Parameter suffix handling for model names and resolution results.
 */

function splitModelParameters(model) {
  if (typeof model !== 'string') return { baseModel: model, parameterSuffix: '' };
  const queryIndex = model.indexOf('?');
  if (queryIndex === -1) return { baseModel: model, parameterSuffix: '' };
  return {
    baseModel: model.slice(0, queryIndex),
    parameterSuffix: model.slice(queryIndex),
  };
}

function appendModelParameters(model, parameterSuffix) {
  if (!parameterSuffix || typeof model !== 'string' || model.includes('?')) return model;
  return `${model}${parameterSuffix}`;
}

function applyModelParametersToResolution(resolution, parameterSuffix) {
  if (!resolution || !parameterSuffix) return resolution;
  return {
    ...resolution,
    resolvedModel: appendModelParameters(resolution.resolvedModel, parameterSuffix),
    ...(Array.isArray(resolution.candidates)
      ? { candidates: resolution.candidates.map(candidate => appendModelParameters(candidate, parameterSuffix)) }
      : {}),
  };
}

module.exports = {
  splitModelParameters,
  appendModelParameters,
  applyModelParametersToResolution,
};
