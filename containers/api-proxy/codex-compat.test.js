const { once } = require('events');
const {
  APPLY_PATCH_FUNCTION_TOOL,
  CodexCompatibilityError,
  translateCodexCustomToolsForCopilot,
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

    const transformed = translateCodexCustomToolsForCopilot(body);

    expect(transformed).not.toBeNull();
    expect(json(transformed).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
  });

  test('translates replayed custom apply_patch calls and outputs to function items', () => {
    const body = Buffer.from(JSON.stringify({
      input: [
        { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch\n' },
        { type: 'custom_tool_call_output', call_id: 'call_1', output: 'Done' },
      ],
    }));

    const transformed = translateCodexCustomToolsForCopilot(body);

    expect(json(transformed).input).toEqual([
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

  test('translates Copilot function calls back to Codex custom tool calls for translated requests', () => {
    const requestBody = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
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

    const transformed = transformCodexCompatibleResponseBody(responseBody, requestBody, 'copilot');

    expect(json(transformed).output).toEqual([{
      type: 'custom_tool_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'apply_patch',
      input: '*** Begin Patch\n*** End Patch\n',
    }]);
  });

  test('does not translate Copilot function calls for unrelated requests', () => {
    const responseBody = Buffer.from(JSON.stringify({
      output: [{
        type: 'function_call',
        call_id: 'call_1',
        name: 'apply_patch',
        arguments: JSON.stringify({ patch: '*** Begin Patch\n*** End Patch\n' }),
      }],
    }));

    expect(transformCodexCompatibleResponseBody(responseBody, Buffer.from('{}'), 'copilot')).toBeNull();
  });

  test('translates streaming function-call items and completed arguments to custom tool events', async () => {
    const requestBody = translateCodexCustomToolsForCopilot(Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch' }],
    })));
    const stream = createCodexCompatibleSseTransform(requestBody, 'copilot');
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk.toString('utf8')));

    stream.end([
      'event: response.output_item.added',
      'data: ' + JSON.stringify({
        type: 'response.output_item.added',
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
});
