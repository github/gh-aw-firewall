'use strict';

const { createRoutingError } = require('./routing-errors');

const ROUTING_GOALS = new Set(['cost', 'cost-speed']);
const ROUTING_MODES = new Set(['economy', 'balanced', 'robust', 'auto']);

function configurationError(detail) {
  return createRoutingError('routing_configuration_error', detail);
}

function requireClosedObject(value, path, requiredKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw configurationError(`${path} must be an object`);
  }

  const keys = Object.keys(value);
  const unknown = keys.find(key => !requiredKeys.includes(key));
  if (unknown) {
    throw configurationError(`${path}.${unknown} is not supported`);
  }
  const missing = requiredKeys.find(key => !Object.hasOwn(value, key));
  if (missing) {
    throw configurationError(`${path}.${missing} is required`);
  }
}

function requireNonblankString(value, path) {
  if (typeof value !== 'string' || !value.trim()) {
    throw configurationError(`${path} must be a nonblank string`);
  }
  return value;
}

function parseRoutingConfig(raw) {
  if (raw === undefined) return null;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw configurationError('AWF_ROUTING_CONFIG must contain JSON');
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configurationError('AWF_ROUTING_CONFIG must contain valid JSON');
  }

  requireClosedObject(value, 'routing', ['objective', 'task']);
  requireClosedObject(value.objective, 'routing.objective', ['goal', 'mode']);
  requireClosedObject(value.task, 'routing.task', ['conversationFile']);

  if (!ROUTING_GOALS.has(value.objective.goal)) {
    throw configurationError('routing.objective.goal is not supported');
  }
  if (!ROUTING_MODES.has(value.objective.mode)) {
    throw configurationError('routing.objective.mode is not supported');
  }

  const config = {
    objective: Object.freeze({
      goal: value.objective.goal,
      mode: value.objective.mode,
    }),
    task: Object.freeze({
      conversationFile: requireNonblankString(
        value.task.conversationFile,
        'routing.task.conversationFile',
      ),
    }),
  };
  return Object.freeze(config);
}

module.exports = {
  parseRoutingConfig,
};
