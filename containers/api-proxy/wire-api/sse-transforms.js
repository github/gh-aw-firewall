'use strict';

const { Transform } = require('stream');
const { StringDecoder } = require('string_decoder');
const { usageToResponses, usageToChat } = require('./response-translation');

function sseEvent(event, data) {
  return `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
}

function parseSseBlock(block) {
  let event = null;
  const data = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
  }
  return { event, data: data.join('\n') };
}

function createResponsesToChatSseTransform(includeUsage) {
  const state = { pending: '', decoder: new StringDecoder('utf8'), id: 'chatcmpl_awf', model: null, created: 0, toolIndexes: new Map(), done: false };
  return createSseTransform(state, (block, current) => {
    const { data } = parseSseBlock(block);
    if (!data || data === '[DONE]') return '';
    let event;
    try { event = JSON.parse(data); } catch { return ''; }
    if (event.type === 'response.created' || event.type === 'response.in_progress') {
      const response = event.response || {};
      current.id = response.id || current.id;
      current.model = response.model || current.model;
      current.created = response.created_at || current.created || Math.floor(Date.now() / 1000);
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.output_text.delta') {
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { content: event.delta || '' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.refusal.delta') {
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { refusal: event.delta || '' }, finish_reason: null }],
      });
    }
    if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') {
      const index = current.toolIndexes.size;
      current.toolIndexes.set(event.item.id || event.item.call_id, index);
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{
          index: 0,
          delta: { tool_calls: [{
            index, id: event.item.call_id || event.item.id, type: 'function',
            function: { name: event.item.name, arguments: '' },
          }] },
          finish_reason: null,
        }],
      });
    }
    if (event.type === 'response.function_call_arguments.delta') {
      const key = event.item_id || event.call_id;
      const index = current.toolIndexes.get(key) ?? event.output_index ?? 0;
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{ index: 0, delta: { tool_calls: [{ index, function: { arguments: event.delta || '' } }] }, finish_reason: null }],
      });
    }
    if (event.type === 'response.completed') {
      const response = event.response || {};
      current.done = true;
      return sseEvent(null, {
        id: current.id, object: 'chat.completion.chunk', created: current.created, model: current.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: response.output?.some(item => item.type === 'function_call')
            ? 'tool_calls'
            : response.status === 'incomplete'
              ? (response.incomplete_details?.reason === 'content_filter' ? 'content_filter' : 'length')
              : 'stop',
        }],
        ...(includeUsage && usageToChat(response.usage) ? { usage: usageToChat(response.usage) } : {}),
      }) + 'data: [DONE]\n\n';
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      current.done = true;
      return sseEvent(null, { error: event.error || event });
    }
    return '';
  });
}

function createChatToResponsesSseTransform() {
  const state = {
    pending: '', decoder: new StringDecoder('utf8'), id: 'resp_awf', model: null,
    created: Math.floor(Date.now() / 1000), responseStarted: false, text: '', refusal: '', textIndex: null,
    tools: new Map(), output: [], nextOutputIndex: 0, finishReason: null, done: false,
  };
  function start(current) {
    if (current.responseStarted) return '';
    current.responseStarted = true;
    return sseEvent('response.created', {
      type: 'response.created',
      response: { id: current.id, object: 'response', status: 'in_progress', model: current.model, output: [] },
    });
  }
  function ensureMessageItem(current) {
    if (current.textIndex !== null) return '';
    current.textIndex = current.nextOutputIndex++;
    return sseEvent('response.output_item.added', {
      type: 'response.output_item.added', output_index: current.textIndex,
      item: { type: 'message', id: `msg_${current.id}`, role: 'assistant', status: 'in_progress', content: [] },
    });
  }
  function finish(current, usage) {
    if (current.done) return '';
    current.done = true;
    let events = start(current);
    if (current.textIndex !== null) {
      const content = [
        ...(current.text ? [{ type: 'output_text', text: current.text, annotations: [] }] : []),
        ...(current.refusal ? [{ type: 'refusal', refusal: current.refusal }] : []),
      ];
      const item = {
        type: 'message', id: `msg_${current.id}`, role: 'assistant', status: 'completed',
        content,
      };
      if (current.text) {
        events += sseEvent('response.output_text.done', {
          type: 'response.output_text.done', item_id: item.id, output_index: current.textIndex, content_index: 0, text: current.text,
        });
        events += sseEvent('response.content_part.done', {
          type: 'response.content_part.done', item_id: item.id, output_index: current.textIndex, content_index: 0,
          part: item.content[0],
        });
      }
      if (current.refusal) {
        events += sseEvent('response.refusal.done', {
          type: 'response.refusal.done', item_id: item.id, output_index: current.textIndex, content_index: content.length - 1,
          refusal: current.refusal,
        });
      }
      events += sseEvent('response.output_item.done', {
        type: 'response.output_item.done', output_index: current.textIndex, item,
      });
      current.output[current.textIndex] = item;
    }
    for (const tool of current.tools.values()) {
      const index = tool.outputIndex;
      const item = {
        type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name,
        arguments: tool.arguments, status: 'completed',
      };
      events += sseEvent('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done', item_id: tool.id, output_index: index, arguments: tool.arguments,
      });
      events += sseEvent('response.output_item.done', { type: 'response.output_item.done', output_index: index, item });
      current.output[index] = item;
    }
    const response = {
      id: current.id, object: 'response',
      status: current.finishReason === 'length' || current.finishReason === 'content_filter' ? 'incomplete' : 'completed',
      ...(current.finishReason === 'length' || current.finishReason === 'content_filter'
        ? { incomplete_details: { reason: current.finishReason === 'length' ? 'max_output_tokens' : 'content_filter' } }
        : {}),
      created_at: current.created,
      model: current.model, output: current.output.filter(Boolean),
      ...(usageToResponses(usage) ? { usage: usageToResponses(usage) } : {}),
    };
    return events + sseEvent('response.completed', { type: 'response.completed', response });
  }
  return createSseTransform(state, (block, current) => {
    const { data } = parseSseBlock(block);
    if (!data || data === '[DONE]') return finish(current, null);
    let event;
    try { event = JSON.parse(data); } catch { return `${block}\n\n`; }
    if (event.error) {
      current.done = true;
      return sseEvent('error', { type: 'error', error: event.error });
    }
    const choice = event.choices?.[0];
    if (!choice) {
      if (event.usage) return finish(current, event.usage);
      return '';
    }
    current.id = event.id || current.id;
    current.model = event.model || current.model;
    let output = start(current);
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      output += ensureMessageItem(current);
      if (current.text.length === 0) {
        output += sseEvent('response.content_part.added', {
          type: 'response.content_part.added', item_id: `msg_${current.id}`, output_index: current.textIndex, content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        });
      }
      current.text += delta.content;
      output += sseEvent('response.output_text.delta', {
        type: 'response.output_text.delta', item_id: `msg_${current.id}`, output_index: current.textIndex, content_index: 0, delta: delta.content,
      });
    }
    if (typeof delta.refusal === 'string' && delta.refusal) {
      output += ensureMessageItem(current);
      current.refusal += delta.refusal;
      output += sseEvent('response.refusal.delta', {
        type: 'response.refusal.delta', item_id: `msg_${current.id}`, output_index: current.textIndex,
        content_index: current.text ? 1 : 0, delta: delta.refusal,
      });
    }
    for (const call of delta.tool_calls || []) {
      const callIndex = Number(call.index || 0);
      let tool = current.tools.get(callIndex);
      if (!tool) {
        tool = {
          id: call.id || `call_${current.id}_${current.nextOutputIndex}`,
          name: '',
          arguments: '',
          outputIndex: current.nextOutputIndex++,
        };
        current.tools.set(callIndex, tool);
        output += sseEvent('response.output_item.added', {
          type: 'response.output_item.added', output_index: tool.outputIndex,
          item: { type: 'function_call', id: tool.id, call_id: tool.id, name: '', arguments: '', status: 'in_progress' },
        });
      }
      if (call.id) tool.id = call.id;
      if (call.function?.name) tool.name += call.function.name;
      if (call.function?.arguments) {
        tool.arguments += call.function.arguments;
        output += sseEvent('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: tool.id, output_index: tool.outputIndex, delta: call.function.arguments,
        });
      }
    }
    if (choice.finish_reason) current.finishReason = choice.finish_reason;
    return output;
  });
}

function createSseTransform(state, translate) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      state.pending += state.decoder.write(chunk);
      const blocks = state.pending.split(/\r?\n\r?\n/);
      state.pending = blocks.pop() || '';
      try {
        for (const block of blocks) if (block) this.push(translate(block, state));
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      state.pending += state.decoder.end();
      try {
        if (state.pending) this.push(translate(state.pending, state));
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

function createWireApiSseTransform(compatibility) {
  if (!compatibility || compatibility.passthrough) return null;
  return compatibility.direction === 'responses_to_chat'
    ? createChatToResponsesSseTransform()
    : createResponsesToChatSseTransform(compatibility.includeUsage);
}

module.exports = {
  createWireApiSseTransform,
};
