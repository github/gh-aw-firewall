const { once } = require('events');
const {
  APPLY_PATCH_FUNCTION_TOOL,
  CodexCompatibilityError,
  translateCodexCustomToolsForCopilot,
  carryForwardCodexCompatibility,
  transformCodexCompatibleResponseBody,
  createCodexCompatibleSseTransform,
} = require('./codex-compat');

function json(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

describe('Codex apply_patch compatibility transform', () => {
  test('translates Codex custom apply_patch tool definitions to Copilot function tools', () => {
    const body = Buffer.from(JSON.stringify({
      model: 'gpt-5-mini',
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
      input: 'edit a file',
    }));

    const translated = translateCodexCustomToolsForCopilot(body);

    expect(translated).not.toBeNull();
    expect(translated.compatibility.customTools.has('apply_patch')).toBe(true);
    expect(json(translated.body).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
  });

  test('translates replayed custom apply_patch calls and outputs to function items', () => {
    const body = Buffer.from(JSON.stringify({
      input: [
        { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
      ],
    }));

    const translated = translateCodexCustomToolsForCopilot(body);

    expect(json(translated.body).input).toEqual([
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }),
      },
      { type: 'function_call_output', call_id: 'call_1', output: 'Done' },
    ]);
  });

  test('fails explicitly for unsupported custom tools', () => {
    const body = Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'freeform_shell' }],
    }));

    expect(() => translateCodexCustomToolsForCopilot(body)).toThrow(CodexCompatibilityError);
    expect(() => translateCodexCustomToolsForCopilot(body)).toThrow(/Unsupported Responses custom tool 'freeform_shell'/);
  });

  test('returns null for bodies with no Codex custom-tool constructs', () => {
    const body = Buffer.from(JSON.stringify({ model: 'gpt-5-mini', tools: [{ type: 'function', name: 'foo' }] }));
    expect(translateCodexCustomToolsForCopilot(body)).toBeNull();
  });

  test('carries forward compatibility metadata across a rebuilt request body (model-endpoint-blocked retry)', () => {
    const translated = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));

    const carried = carryForwardCodexCompatibility(translated.compatibility);
    expect(carried).toBe(translated.compatibility);
    expect(carried.customTools.has('apply_patch')).toBe(true);
    expect(carryForwardCodexCompatibility(null)).toBeNull();
  });

  test('translates Copilot function calls back to Codex custom tool calls for translated requests', () => {
    const translated = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));
    const responseBody = Buffer.from(JSON.stringify({
      id: 'resp_1',
      output: [{
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }),
      }],
    }));

    const transformed = transformCodexCompatibleResponseBody(responseBody, translated.compatibility, 'copilot');

    expect(json(transformed).output).toEqual([{
      type: 'custom_tool_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** End Patch\n',
    }]);
  });

  test('does not translate Copilot function calls when there is no compatibility metadata', () => {
    const responseBody = Buffer.from(JSON.stringify({
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }),
      }],
    }));

    expect(transformCodexCompatibleResponseBody(responseBody, null, 'copilot')).toBeNull();
  });

  test('translates streaming function-call items and completed arguments to custom tool events', async () => {
    const translated = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));
    const stream = createCodexCompatibleSseTransform(translated.compatibility, 'copilot');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk.toString('utf8')));

    stream.end([
      'event: response.output_item.added',
      'data: ' + JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'apply_patch',
          arguments: '',
        },
      }),
      '',
      'event: response.function_call_arguments.done',
      'data: ' + JSON.stringify({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        output_index: 0,
        arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }),
      }),
      '',
    ].join('\n'));

    await once(stream, 'end');
    const output = chunks.join('');

    expect(output).toContain('event: response.output_item.added');
    expect(output).toContain('"type":"custom_tool_call"');
    expect(output).toContain('event: response.custom_tool_call_input.delta');
    expect(output).toContain('"delta":"*** Begin Patch\\n*** End Patch\\n"');
    expect(output).toContain('event: response.custom_tool_call_input.done');
    expect(output).toContain('"input":"*** Begin Patch\\n*** End Patch\\n"');
  });

  test('passes through argument events for an unrelated function call in a mixed-tool stream', async () => {
    const translated = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));
    const stream = createCodexCompatibleSseTransform(translated.compatibility, 'copilot');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk.toString('utf8')));

    const otherFunctionArgs = JSON.stringify({ query: 'hello' });

    stream.end([
      'event: response.output_item.added',
      'data: ' + JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_other', call_id: 'call_other', name: 'search', arguments: '' },
      }),
      '',
      'event: response.function_call_arguments.done',
      'data: ' + JSON.stringify({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_other',
        output_index: 0,
        arguments: otherFunctionArgs,
      }),
      '',
    ].join('\n'));

    await once(stream, 'end');
    const output = chunks.join('');

    // The unrelated function call's item and its completed-arguments event
    // must pass through untouched -- not rewritten as a custom tool call.
    expect(output).toContain('"name":"search"');
    expect(output).toContain('event: response.function_call_arguments.done');
    expect(output).toContain(JSON.stringify(otherFunctionArgs).slice(1, -1));
    expect(output).not.toContain('custom_tool_call');
  });

  test('reassembles a multibyte UTF-8 patch character split across chunk boundaries', async () => {
    const translated = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));
    const stream = createCodexCompatibleSseTransform(translated.compatibility, 'copilot');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk.toString('utf8')));

    const patch = '*** Begin Patch\n+caf\u00e9\n*** End Patch\n';
    const fullBlock = [
      'event: response.output_item.added',
      'data: ' + JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'apply_patch', arguments: '' },
      }),
      '',
      'event: response.function_call_arguments.done',
      'data: ' + JSON.stringify({
        type: 'response.function_call_arguments.done',
        item_id: 'fc_1',
        output_index: 0,
        arguments: JSON.stringify({ patch }),
      }),
      '',
    ].join('\n');

    const fullBuffer = Buffer.from(fullBlock, 'utf8');
    // Split the buffer in the middle of the multibyte 'é' (U+00E9, 2 bytes in UTF-8).
    const splitIndex = fullBuffer.indexOf(Buffer.from('caf\u00e9', 'utf8')) + 4; // 3 ASCII bytes + 1st byte of 'é'
    const first = fullBuffer.subarray(0, splitIndex);
    const second = fullBuffer.subarray(splitIndex);

    stream.write(first);
    stream.end(second);

    await once(stream, 'end');
    const output = chunks.join('');

    expect(output).toContain('caf\u00e9');
    expect(output).not.toContain('\uFFFD');
  });
});
