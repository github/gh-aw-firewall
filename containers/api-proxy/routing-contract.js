'use strict';

const Ajv2020 = require('ajv/dist/2020');
const { createRoutingError } = require('./routing-errors');

const MAX_PLANNING_REQUEST_BYTES = 1_048_576;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const MODES = ['economy', 'balanced', 'robust'];

const definitions = {
  effort: { type: 'string', enum: EFFORTS },
  choice: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'model'],
    properties: {
      id: { type: 'string', minLength: 1 },
      model: { type: 'string', minLength: 1, pattern: '^[^/]+/[^/]+$' },
      effort: { anyOf: [{ $ref: '#/$defs/effort' }, { type: 'null' }] },
    },
  },
  textPart: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: { text: { type: 'string' } },
  },
  toolCallPart: {
    type: 'object',
    additionalProperties: false,
    required: ['tool_call'],
    properties: {
      tool_call: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'name'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          input: {},
        },
      },
    },
  },
  toolResultPart: {
    type: 'object',
    additionalProperties: false,
    required: ['tool_result'],
    properties: {
      tool_result: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          text: { type: ['string', 'null'] },
          ok: { type: ['boolean', 'null'] },
        },
      },
    },
  },
  part: {
    oneOf: [
      { $ref: '#/$defs/textPart' },
      { $ref: '#/$defs/toolCallPart' },
      { $ref: '#/$defs/toolResultPart' },
    ],
  },
  message: {
    type: 'object',
    additionalProperties: false,
    required: ['role'],
    properties: {
      role: { type: 'string', enum: ['system', 'user', 'assistant'] },
      parts: { type: 'array', items: { $ref: '#/$defs/part' } },
    },
  },
  conversation: {
    type: 'array',
    items: { $ref: '#/$defs/message' },
  },
  labels: {
    type: 'object',
    additionalProperties: false,
    required: ['task_type', 'scope', 'task_complexity'],
    properties: {
      task_type: {
        type: 'string',
        enum: ['explain', 'plan', 'fix', 'refactor', 'chore', 'implement', 'unknown'],
      },
      scope: {
        type: 'string',
        enum: ['local', 'multi_file', 'subsystem', 'cross_system', 'unknown'],
      },
      task_complexity: {
        type: 'string',
        enum: ['trivial', 'easy', 'medium', 'hard', 'expert', 'unknown'],
      },
    },
  },
  classifierOutput: {
    type: 'object',
    additionalProperties: false,
    required: ['labels', 'mode'],
    properties: {
      labels: { $ref: '#/$defs/labels' },
      mode: { type: 'string', enum: [...MODES, 'unknown'] },
    },
  },
};

const ajv = new Ajv2020({ strict: true });

function compile(schema) {
  return ajv.compile({
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $defs: definitions,
    ...schema,
  });
}

const validateConversationSchema = compile({ $ref: '#/$defs/conversation' });
const validateCapabilitiesSchema = compile({
  type: 'object',
  additionalProperties: false,
  required: ['name', 'version', 'routing_profiles', 'execution_catalogue'],
  properties: {
    name: { type: 'string' },
    version: { type: 'string' },
    routing_profiles: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['goal', 'mode'],
        properties: {
          goal: { type: 'string', enum: ['cost', 'cost-speed'] },
          mode: { type: 'string', enum: MODES },
        },
      },
    },
    execution_catalogue: {
      type: 'object',
      additionalProperties: false,
      required: ['models'],
      properties: {
        models: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['model', 'efforts'],
            properties: {
              model: { type: 'string', pattern: '^[^/]+/[^/]+$' },
              efforts: { type: 'array', items: { $ref: '#/$defs/effort' } },
            },
          },
        },
      },
    },
  },
});
const validateClassifyResponseSchema = compile({
  type: 'object',
  additionalProperties: false,
  required: ['system_prompt', 'prompt', 'ranked_choices'],
  properties: {
    system_prompt: { type: 'string', minLength: 1 },
    prompt: { type: 'string' },
    ranked_choices: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/choice' },
    },
  },
});
const validateClassifierOutputSchema = compile({ $ref: '#/$defs/classifierOutput' });
const validateRouteResponseSchema = compile({
  type: 'object',
  additionalProperties: false,
  required: ['ranked_choices'],
  properties: {
    ranked_choices: {
      type: 'array',
      minItems: 1,
      items: { $ref: '#/$defs/choice' },
    },
  },
});

function contractError(detail) {
  throw createRoutingError('routing_contract_error', detail);
}

function validateConversation(conversation) {
  if (!validateConversationSchema(conversation)) {
    contractError('The routing conversation does not match the router contract');
  }
  const hasAuthoredUserText = conversation.some(message =>
    message.role === 'user' &&
    Array.isArray(message.parts) &&
    message.parts.some(part => typeof part.text === 'string' && part.text.trim()),
  );
  if (!hasAuthoredUserText) {
    contractError('The routing conversation must contain a nonblank user message');
  }
  return conversation;
}

function validateCapabilities(capabilities, objective, expected = {}) {
  if (!validateCapabilitiesSchema(capabilities)) {
    contractError('The router capabilities response is invalid');
  }
  if (expected.name && capabilities.name !== expected.name) {
    contractError('The router service identity does not match the tested artifact');
  }
  if (expected.version && capabilities.version !== expected.version) {
    contractError('The router version does not match the tested artifact');
  }

  const available = new Set(
    capabilities.routing_profiles.map(profile => `${profile.goal}/${profile.mode}`),
  );
  const requiredModes = objective.mode === 'auto' ? MODES : [objective.mode];
  if (requiredModes.some(mode => !available.has(`${objective.goal}/${mode}`))) {
    contractError('The router does not provide every required routing profile');
  }
  return capabilities;
}

function choiceKey(choice) {
  const effort = Object.hasOwn(choice, 'effort')
    ? (choice.effort === null ? '<null>' : choice.effort)
    : '<omitted>';
  return `${choice.id}\u0000${choice.model}\u0000${effort}`;
}

function validateRankedChoices(rankedChoices, offeredChoices, context) {
  const offered = new Set(offeredChoices.map(choiceKey));
  const seen = new Set();
  for (const choice of rankedChoices) {
    const key = choiceKey(choice);
    if (!offered.has(key)) contractError(`${context} returned a choice that was not offered`);
    if (seen.has(key)) contractError(`${context} returned a duplicate choice`);
    seen.add(key);
  }
}

function validateClassifyResponse(response, offeredChoices) {
  if (!validateClassifyResponseSchema(response)) {
    contractError('The router classifier plan is invalid');
  }
  validateRankedChoices(response.ranked_choices, offeredChoices, 'The router classifier plan');
  return response;
}

function validateClassifierOutput(raw) {
  let parsed;
  try {
    parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  } catch {
    return null;
  }
  return validateClassifierOutputSchema(parsed) ? parsed : null;
}

function validateRouteResponse(response, offeredChoices) {
  if (!validateRouteResponseSchema(response)) {
    contractError('The router route response is invalid');
  }
  validateRankedChoices(response.ranked_choices, offeredChoices, 'The router route response');
  return response;
}

function toRouteCandidates(pool) {
  return pool.choices.map(choice => {
    const mapping = pool.byId[choice.id];
    return {
      ...choice,
      ...(mapping.contextWindow === undefined ? {} : { context_window: mapping.contextWindow }),
    };
  });
}

function getSerializedByteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertPlanningRequestSize(value) {
  if (getSerializedByteLength(value) > MAX_PLANNING_REQUEST_BYTES) {
    throw createRoutingError(
      'routing_input_too_large',
      'The serialized routing request exceeds 1048576 bytes',
    );
  }
}

module.exports = {
  MAX_PLANNING_REQUEST_BYTES,
  assertPlanningRequestSize,
  getSerializedByteLength,
  toRouteCandidates,
  validateCapabilities,
  validateClassifierOutput,
  validateClassifyResponse,
  validateConversation,
  validateRouteResponse,
};
