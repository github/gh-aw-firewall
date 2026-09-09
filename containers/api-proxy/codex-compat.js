'use strict';

const { Transform } = require('stream');
const { parseBodyAsObject } = require('./body-utils');

const APPLY_PATCH_TOOL = 'apply_patch';

const APPLY_PATCH_FUNCTION_TOOL = Object.freeze({
  type: 'function',
  name: APPLY_PATCH_TOOL,
  description: 'Apply a patch to files in the workspace.',
  parameters: {
    type: 'object',
    properties: {
      patch: {
        type: 'string',
        description: 'Patch contents in apply_patch format.',
      },
    },
    required: ['patch'],
    additionalProperties: false,
  },
});

const translatedRequestBodies = new WeakMap();

class CodexCompatibilityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodexCompatibilityError';
    this.statusCode = 400;
    this.code = 'unsupported_custom_tool';
  }
}

function cloneApplyPatchFunctionTool() {
  return {
    ...APPLY_PATCH_FUNCTION_TOOL,
    parameters: {
      ...APPLY_PATCH_FUNCTION_TOOL.parameters,
      properties: {
        patch: { ...APPLY_PATCH_FUNCTION_TOOL.parameters.properties.patch },
      },
      required: [...APPLY_PATCH_FUNCTION_TOOL.parameters.required],
    },
  };
}

function parsePatchArgument(argumentsValue) {
  if (typeof argumentsValue !== 'string') return null;
  try {
    const parsed = JSON.parse(argumentsValue);
    if (parsed && typeof parsed === 'object' && typeof parsed.patch === 'string') {
      return parsed.patch;
    }
  } catch {
    return null;
  }
  return null;
}

function toFunctionCall(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.type !== 'custom_tool_call') return item;
  if (item.name !== APPLY_PATCH_TOOL) {
    throw new CodexCompatibilityError(
      `Unsupported Responses custom tool call '${item.name || '(unknown)'}'. ` +
      `Only '${APPLY_PATCH_TOOL}' is supported through the Copilot compatibility adapter.`
    );
  }

  const { input, ...rest } = item;
  return {
    ...rest,
    type: 'function_call',
    arguments: JSON.stringify({ patch: typeof input === 'string' ? input : '' }),
  };
}

function toFunctionCallOutput(item) {
  if (!item || typeof item !== 'object') return item;
  if (item.type !== 'custom_tool_call_output') return item;
  return {
    ...item,
    type: 'function_call_output',
  };
}

function translateInputItems(input) {
  if (!Array.isArray(input)) return { input, changed: false };

  let changed = false;
  const nextInput = input.map((item) => {
    const asFunctionCall = toFunctionCall(item);
    const asFunctionOutput = toFunctionCallOutput(asFunctionCall);
    if (asFunctionOutput !== item) changed = true;
    return asFunctionOutput;
  });

  return { input: nextInput, changed };
}

function translateCodexCustomToolsForCopilot(body) {
  const parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  let changed = false;
  const customTools = new Set();

  if (Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map((tool) => {
      if (!tool || typeof tool !== 'object' || tool.type !== 'custom') return tool;
      if (tool.name !== APPLY_PATCH_TOOL) {
        throw new CodexCompatibilityError(
          `Unsupported Responses custom tool '${tool.name || '(unknown)'}'. ` +
          `Only '${APPLY_PATCH_TOOL}' is supported through the Copilot compatibility adapter.`
        );
      }
      changed = true;
      customTools.add(APPLY_PATCH_TOOL);
      return cloneApplyPatchFunctionTool(tool);
    });
  }

  const translatedInput = translateInputItems(parsed.input);
  if (translatedInput.changed) {
    parsed.input = translatedInput.input;
    changed = true;
    customTools.add(APPLY_PATCH_TOOL);
  }

  if (!changed) return null;

  const nextBody = Buffer.from(JSON.stringify(parsed));
  translatedRequestBodies.set(nextBody, { customTools });
  return nextBody;
}

function getCodexCompatibilityForRequestBody(body) {
  return translatedRequestBodies.get(body) || null;
}

function toCustomToolCall(item, compatibility) {
  if (
    !compatibility ||
    !compatibility.customTools ||
    !compatibility.customTools.has(APPLY_PATCH_TOOL) ||
    !item ||
    typeof item !== 'object' ||
    item.type !== 'function_call' ||
    item.name !== APPLY_PATCH_TOOL
  ) {
    return { item, changed: false };
  }

  const patch = parsePatchArgument(item.arguments);

  const rest = { ...item };
  delete rest.arguments;
  return {
    item: {
      ...rest,
      type: 'custom_tool_call',
      input: patch === null ? '' : patch,
    },
    changed: true,
  };
}

function translateResponseObject(value, compatibility) {
  if (!value || typeof value !== 'object') return { value, changed: false };

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry) => {
      const translated = translateResponseObject(entry, compatibility);
      if (translated.changed) changed = true;
      return translated.value;
    });
    return { value: next, changed };
  }

  const direct = toCustomToolCall(value, compatibility);
  if (direct.changed) return { value: direct.item, changed: true };

  let changed = false;
  const next = { ...value };
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'output' && key !== 'item' && key !== 'response') continue;
    const translated = translateResponseObject(child, compatibility);
    if (translated.changed) {
      next[key] = translated.value;
      changed = true;
    }
  }

  return { value: changed ? next : value, changed };
}

function transformCodexCompatibleResponseBody(body, requestBody, provider) {
  if (provider !== 'copilot') return null;
  const compatibility = getCodexCompatibilityForRequestBody(requestBody);
  if (!compatibility) return null;

  const parsed = parseBodyAsObject(body);
  if (!parsed) return null;

  const translated = translateResponseObject(parsed, compatibility);
  if (!translated.changed) return null;
  return Buffer.from(JSON.stringify(translated.value));
}

function parseSseEvent(block) {
  const lines = block.split(/\r?\n/);
  let eventName = null;
  const dataLines = [];
  const passthrough = [];

  for (const line of lines) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trimStart();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    } else {
      passthrough.push(line);
    }
  }

  return { eventName, data: dataLines.join('\n'), passthrough };
}

function formatSseEvent(eventName, data, passthrough = []) {
  const lines = [];
  if (eventName) lines.push(`event: ${eventName}`);
  for (const line of passthrough) {
    if (line) lines.push(line);
  }
  lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return `${lines.join('\n')}\n\n`;
}

function appendPatchDelta(state, key, argumentsDelta) {
  const current = state.argumentsByItem.get(key) || '';
  state.argumentsByItem.set(key, current + argumentsDelta);
  const patch = parsePatchArgument(state.argumentsByItem.get(key));
  if (patch === null) return null;

  const sent = state.patchByItem.get(key) || '';
  if (!patch.startsWith(sent)) return null;

  const delta = patch.slice(sent.length);
  state.patchByItem.set(key, patch);
  return delta;
}

function itemKey(data) {
  return String(data.item_id || data.output_index || data.call_id || 'default');
}

function translateFunctionArgumentsEvent(data, state, done) {
  const key = itemKey(data);
  const delta = typeof data.delta === 'string' ? appendPatchDelta(state, key, data.delta) : null;
  const fullPatch = typeof data.arguments === 'string' ? parsePatchArgument(data.arguments) : null;
  const events = [];
  const customEventBase = { ...data };
  delete customEventBase.arguments;

  if (fullPatch !== null) {
    const sent = state.patchByItem.get(key) || '';
    if (fullPatch.startsWith(sent) && fullPatch.length > sent.length) {
      events.push({
        ...customEventBase,
        type: 'response.custom_tool_call_input.delta',
        delta: fullPatch.slice(sent.length),
      });
    }
    state.patchByItem.set(key, fullPatch);
  } else if (delta) {
    events.push({
      ...customEventBase,
      type: 'response.custom_tool_call_input.delta',
      delta,
    });
  }

  if (done) {
    events.push({
      ...customEventBase,
      type: 'response.custom_tool_call_input.done',
      input: state.patchByItem.get(key) || '',
    });
  }

  return events;
}

function translateSseBlock(block, state, compatibility) {
  const parsed = parseSseEvent(block);
  if (!parsed.data || parsed.data === '[DONE]') return `${block}\n\n`;

  let data;
  try {
    data = JSON.parse(parsed.data);
  } catch {
    return `${block}\n\n`;
  }

  const eventType = parsed.eventName || data.type;
  if (eventType === 'response.function_call_arguments.delta') {
    const events = translateFunctionArgumentsEvent(data, state, false);
    return events.map(event =>
      formatSseEvent('response.custom_tool_call_input.delta', event, parsed.passthrough)
    ).join('');
  }

  if (eventType === 'response.function_call_arguments.done') {
    const events = translateFunctionArgumentsEvent(data, state, true);
    return events.map(event =>
      formatSseEvent(event.type, event, parsed.passthrough)
    ).join('');
  }

  const translated = translateResponseObject(data, compatibility);
  if (!translated.changed) return `${block}\n\n`;
  const nextEventName = parsed.eventName === eventType && translated.value.type
    ? translated.value.type
    : parsed.eventName;
  return formatSseEvent(nextEventName, translated.value, parsed.passthrough);
}

function createCodexCompatibleSseTransform(requestBody, provider) {
  if (provider !== 'copilot') return null;
  const compatibility = getCodexCompatibilityForRequestBody(requestBody);
  if (!compatibility) return null;

  const state = {
    pending: '',
    argumentsByItem: new Map(),
    patchByItem: new Map(),
  };

  return new Transform({
    transform(chunk, _encoding, callback) {
      state.pending += chunk.toString('utf8');
      const blocks = state.pending.split(/\r?\n\r?\n/);
      state.pending = blocks.pop() || '';
      try {
        for (const block of blocks) {
          if (!block) continue;
          this.push(translateSseBlock(block, state, compatibility));
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
    flush(callback) {
      try {
        if (state.pending) {
          this.push(translateSseBlock(state.pending, state, compatibility));
        }
        callback();
      } catch (err) {
        callback(err);
      }
    },
  });
}

module.exports = {
  APPLY_PATCH_FUNCTION_TOOL,
  CodexCompatibilityError,
  translateCodexCustomToolsForCopilot,
  getCodexCompatibilityForRequestBody,
  transformCodexCompatibleResponseBody,
  createCodexCompatibleSseTransform,
  _testing: {
    parsePatchArgument,
  },
};
