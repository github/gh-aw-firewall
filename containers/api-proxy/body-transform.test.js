const { injectSteeringMessage, injectStreamOptions, describeSteeringConversation } = require('./body-transform');
const { STORED_RESPONSE_CONVERSATION } = require('./guards/steering-thresholds');
const { makeAnthropicTransform } = require('./anthropic-transforms');

describe('injectStreamOptions', () => {
  test('injects include_usage for streaming chat completions requests', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'openai', '/v1/chat/completions');

    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  describe('injectSteeringMessage for Responses requests', () => {
    const warning = '[AWF AI CREDIT WARNING] Use the remaining budget carefully.';

    test.each([
      ['tool loop ending in a function result', {
        instructions: 'Keep working carefully.',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Continue the task.' }] },
          { type: 'reasoning', id: 'reasoning-1', summary: [] },
          { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{}' },
          { type: 'function_call_output', call_id: 'call-1', output: 'file contents' },
        ],
      }],
      ['input ending in a user message', {
        instructions: 'Keep working carefully.',
        input: [{ role: 'user', content: 'Continue the task.' }],
      }],
      ['no instructions', { input: [{ role: 'user', content: 'Continue the task.' }] }],
      ['null instructions', { instructions: null, input: [{ role: 'user', content: 'Continue the task.' }] }],
      ['string input', { instructions: 'Keep working carefully.', input: 'Continue the task.' }],
      ['empty input', { input: [] }],
    ])('appends one final developer notice preserving the prefix for %s', (_name, request) => {
      const original = {
        model: 'gpt-5-mini',
        ...request,
        tools: [{ type: 'function', name: 'read_file', parameters: { type: 'object' } }],
        prompt_cache_key: 'stable-cache-key',
        stream: true,
      };
      const body = Buffer.from(JSON.stringify(original));
      const input = typeof original.input === 'string'
        ? [{ role: 'user', content: original.input }]
        : original.input;
      const baseline = JSON.stringify({ ...original, input });
      const prefixEnd = baseline.indexOf(JSON.stringify(input)) + JSON.stringify(input).length - 1;

      const result = injectSteeringMessage(body, 'copilot', warning, '/v1/responses');

      expect(result).not.toBeNull();
      expect(result.subarray(0, Buffer.byteLength(baseline.slice(0, prefixEnd))))
        .toEqual(Buffer.from(baseline.slice(0, prefixEnd)));
      const parsed = JSON.parse(result.toString());
      expect(parsed.input).toHaveLength(input.length + 1);
      expect(parsed.input.pop()).toEqual({ type: 'message', role: 'developer', content: warning });
      expect(JSON.stringify(parsed)).toBe(baseline);
      if (typeof original.input === 'string') parsed.input = original.input;
      expect(Buffer.from(JSON.stringify(parsed))).toEqual(body);
    });

    test('also appends a notice for Responses body shapes on unrecognized paths', () => {
      const result = injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: 'Continue the task.' })),
        'openai',
        warning,
        '/unknown',
      );

      expect(JSON.parse(result.toString())).toEqual({
        input: [
          { role: 'user', content: 'Continue the task.' },
          { type: 'message', role: 'developer', content: warning },
        ],
      });
    });

    test('returns null for malformed Responses input or instructions', () => {
      expect(injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: { text: 'not a supported input' } })),
        'openai',
        warning,
        '/v1/responses',
      )).toBeNull();
      expect(injectSteeringMessage(
        Buffer.from(JSON.stringify({ input: 'hello', instructions: [] })),
        'openai',
        warning,
        '/v1/responses',
      )).toBeNull();
    });
  });

  describe('injectSteeringMessage at the end of the conversation', () => {
    const warning = '[AWF AI CREDIT WARNING] Use the remaining budget carefully.';

    // Each request ends with its conversation array as the last key, so the
    // byte prefix up to the end of the last tool result is the serialized
    // baseline minus the closing brackets.
    test.each([
      ['Messages', 'anthropic', '/v1/messages', {
        model: 'claude-sonnet-5',
        system: [{ type: 'text', text: 'Keep working carefully.', cache_control: { type: 'ephemeral' } }],
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: 'Continue the task.' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'file contents' }] },
        ],
      }, '}]}]}', ',{"type":"text","text":'],
      ['Copilot Messages', 'copilot', '/v1/messages', {
        model: 'claude-sonnet-5',
        system: 'Keep working carefully.',
        messages: [
          { role: 'user', content: 'Continue the task.' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'file contents' }] },
        ],
      }, '}]}]}', ',{"type":"text","text":'],
      ['Chat Completions', 'copilot', '/v1/chat/completions', {
        model: 'claude-sonnet-5',
        tools: [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object' } } }],
        messages: [
          { role: 'system', content: 'Keep working carefully.' },
          { role: 'user', content: 'Continue the task.' },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'call-1', content: 'file contents' },
        ],
      }, '}]}', ',{"role":"user","content":'],
      ['Gemini', 'gemini', '/v1beta/models/gemini-2.5-pro:generateContent', {
        systemInstruction: { parts: [{ text: 'Keep working carefully.' }] },
        tools: [{ functionDeclarations: [{ name: 'read_file' }] }],
        contents: [
          { role: 'user', parts: [{ text: 'Continue the task.' }] },
          { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
          { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'file contents' } } }] },
        ],
      }, '}]}]}', ',{"text":'],
    ])('keeps the %s prefix byte-identical through the last tool result', (_name, provider, path, request, closing, noticeStart) => {
      const baseline = JSON.stringify(request);
      expect(baseline.endsWith(closing)).toBe(true);
      const prefix = baseline.slice(0, baseline.length - closing.length + 1);

      const result = injectSteeringMessage(Buffer.from(baseline), provider, warning, path);

      expect(result).not.toBeNull();
      const serialized = result.toString('utf8');
      expect(serialized.startsWith(prefix + noticeStart)).toBe(true);
      expect(serialized.indexOf(warning)).toBeGreaterThan(serialized.lastIndexOf('file contents'));
      expect(serialized.endsWith(closing.slice(1))).toBe(true);
    });

    test.each([null, 'malformed', []])('leaves Gemini systemInstruction %p untouched', (systemInstruction) => {
      const body = Buffer.from(JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Continue the task.' }] }],
        systemInstruction,
      }));

      const parsed = JSON.parse(injectSteeringMessage(body, 'gemini', warning).toString());

      expect(parsed.systemInstruction).toEqual(systemInstruction);
      expect(parsed.contents[0].parts).toEqual([{ text: 'Continue the task.' }, { text: warning }]);
    });

    test.each([
      ['enabled', true],
      ['disabled', false],
    ])('keeps the cache breakpoint just before the Messages notice with anthropicAutoCache %s', (_name, autoCache) => {
      const request = {
        model: 'claude-sonnet-5',
        system: [{ type: 'text', text: 'Keep working carefully.' }],
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Continue the task.' }] },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu-1', name: 'read_file', input: {} }] },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu-1', content: 'first' },
              // Harness rolling-tail breakpoint (e.g. Claude Code).
              { type: 'tool_result', tool_use_id: 'toolu-2', content: 'second', cache_control: { type: 'ephemeral' } },
            ],
          },
        ],
      };
      let body = Buffer.from(JSON.stringify(request));
      const transform = makeAnthropicTransform({ autoCache });
      if (transform) body = transform(body) || body;
      const beforeNotice = JSON.parse(body.toString());

      const result = injectSteeringMessage(body, 'anthropic', warning, '/v1/messages');

      const parsed = JSON.parse(result.toString());
      const finalContent = parsed.messages.at(-1).content;
      expect(finalContent.at(-1)).toEqual({ type: 'text', text: warning });
      expect(finalContent.at(-2)).toEqual(beforeNotice.messages.at(-1).content.at(-1));
      expect(finalContent.at(-2).cache_control).toEqual(
        autoCache ? { type: 'ephemeral', ttl: '5m' } : { type: 'ephemeral' },
      );
      expect(parsed.system).toEqual(beforeNotice.system);
      expect(parsed.tools).toEqual(beforeNotice.tools);
      finalContent.pop();
      expect(parsed).toEqual(beforeNotice);
    });
  });

  test('does not inject include_usage for OpenAI responses endpoint', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello' }));

    expect(injectStreamOptions(body, 'openai', '/v1/responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', '/responses?foo=1')).toBeNull();
  });

  test('does not inject include_usage for OpenAI responses endpoint without leading slash', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello' }));

    expect(injectStreamOptions(body, 'openai', 'responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', 'v1/responses')).toBeNull();
    expect(injectStreamOptions(body, 'openai', 'v1/responses?foo=1')).toBeNull();
  });

  test('does not inject include_usage when body has input field but no messages (Responses API shape)', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, input: 'hello', model: 'gpt-5-mini' }));

    // Even with an unrecognised path, body-shape guard should catch it
    expect(injectStreamOptions(body, 'openai', '/v1/unknown')).toBeNull();
  });

  test('does not trigger body-shape guard when messages array is present alongside input', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, input: 'hello', messages: [{ role: 'user', content: 'hi' }] })
    );

    // Has both input and messages — not a pure Responses API shape, should still inject
    const transformed = injectStreamOptions(body, 'openai', '/v1/chat/completions');
    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  test('does not inject include_usage for Anthropic Messages endpoint via Copilot provider', () => {
    const body = Buffer.from(
      JSON.stringify({ stream: true, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] })
    );

    expect(injectStreamOptions(body, 'copilot', '/v1/messages')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', '/messages?foo=1')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', 'messages')).toBeNull();
    expect(injectStreamOptions(body, 'copilot', 'v1/messages')).toBeNull();
  });

  test('still injects include_usage for OpenAI-compatible chat completions on copilot provider', () => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'copilot', '/v1/chat/completions');
    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  describe.each(['v1', 'v1beta1'])('Vertex %s endpoints', (version) => {
    test.each(['rawPredict', 'streamRawPredict'])(
      'does not inject include_usage for Anthropic %s',
      (method) => {
        const request = {
          anthropic_version: 'vertex-2023-10-16',
          stream: true,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        };
        const body = Buffer.from(JSON.stringify(request));
        const path = `/${version}/projects/test-project/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:${method}`;

        expect(injectStreamOptions(body, 'vertex', path)).toBeNull();
        expect(injectStreamOptions(body, 'vertex', `${path}?alt=sse`)).toBeNull();
        expect(injectStreamOptions(body, 'vertex', path.slice(1))).toBeNull();
        expect(JSON.parse(body.toString('utf8'))).toEqual(request);
      }
    );

    test.each(['', '?alt=sse'])(
      'still injects include_usage for OpenAI-compatible chat completions%s',
      (query) => {
        const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));
        const path = `/${version}/projects/test-project/locations/us-east5/endpoints/openapi/chat/completions${query}`;

        const transformed = injectStreamOptions(body, 'vertex', path);

        expect(transformed).not.toBeNull();
        expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
      }
    );
  });

  test.each([
    '/messages/../v1/chat/completions',
    '/messages/%2e%2e/v1/chat/completions',
    '/v1/messages/../../v1/chat/completions',
  ])('uses the canonical path before applying route exclusions: %s', (requestPath) => {
    const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

    const transformed = injectStreamOptions(body, 'copilot', requestPath);

    expect(transformed).not.toBeNull();
    expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
  });

  test.each(['/v1/messages/extra', '/v1/responses/extra'])(
    'does not exclude descendants of exact API routes: %s',
    (requestPath) => {
      const body = Buffer.from(JSON.stringify({ stream: true, messages: [{ role: 'user', content: 'hi' }] }));

      const transformed = injectStreamOptions(body, 'copilot', requestPath);

      expect(transformed).not.toBeNull();
      expect(JSON.parse(transformed.body.toString('utf8')).stream_options).toEqual({ include_usage: true });
    }
  );
});

describe('describeSteeringConversation', () => {
  const describe_ = (body, provider, url) =>
    describeSteeringConversation(Buffer.from(JSON.stringify(body)), provider, url);

  test('recognises a Messages conversation across turns, ignoring moved cache breakpoints', () => {
    const system = [
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cch=aaaa;' },
      { type: 'text', text: 'You are a sub-agent.', cache_control: { type: 'ephemeral' } },
    ];
    const first = describe_({
      system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Screen batch 1.', cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ],
    }, 'anthropic', '/v1/messages');
    const later = describe_({
      system: [{ ...system[0], text: 'x-anthropic-billing-header: cc_version=1; cch=bbbb;' }, system[1]],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Screen batch 1.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'y' }, { type: 'text', text: 'reminder' }] },
      ],
    }, 'anthropic', '/v1/messages');
    const other = describe_({
      system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Screen batch 2.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ],
    }, 'anthropic', '/v1/messages');

    expect(first).toEqual({ endsWithToolResult: true, conversation: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(later).toEqual({ endsWithToolResult: true, conversation: first.conversation });
    expect(other.conversation).not.toBe(first.conversation);
  });

  test('distinguishes conversations by their system prompt or instructions', () => {
    const input = [
      { role: 'user', content: 'Task.' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'x' },
    ];
    const main = describe_({ instructions: 'Main agent.', input }, 'openai', '/v1/responses');
    const sub = describe_({ instructions: 'Sub-agent.', input }, 'openai', '/v1/responses');
    expect(main.endsWithToolResult).toBe(true);
    expect(main.conversation).not.toBe(sub.conversation);
  });

  test('includes every opening Responses message before the model replies', () => {
    const opening = [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'Permissions.' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'AGENTS.md' }] },
    ];
    const tail = [
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      { type: 'custom_tool_call_output', call_id: 'c1', output: 'x' },
    ];
    const a = describe_({ instructions: 'Codex.', input: [...opening, { role: 'user', content: 'Task A.' }, ...tail] },
      'openai', '/v1/responses');
    const b = describe_({ instructions: 'Codex.', input: [...opening, { role: 'user', content: 'Task B.' }, ...tail] },
      'openai', '/v1/responses');
    expect(a.endsWithToolResult).toBe(true);
    expect(a.conversation).not.toBe(b.conversation);
  });

  test('treats Responses input messages without a role as user messages', () => {
    const tail = [
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'x' },
    ];
    const a = describe_({ instructions: 'Codex.', input: [{ content: 'Task A.' }, ...tail] },
      'openai', '/v1/responses');
    const b = describe_({ instructions: 'Codex.', input: [{ type: 'message', content: 'Task B.' }, ...tail] },
      'openai', '/v1/responses');
    const explicit = describe_({ instructions: 'Codex.', input: [{ role: 'user', content: 'Task A.' }, ...tail] },
      'openai', '/v1/responses');
    expect(a).toEqual({ endsWithToolResult: true, conversation: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(b.conversation).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(a.conversation).not.toBe(b.conversation);
    expect(a.conversation).toBe(explicit.conversation);
  });

  test('treats a null Responses conversation like an omitted one', () => {
    const input = [
      { role: 'user', content: 'Task.' },
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'x' },
    ];
    const omitted = describe_({ instructions: 'Agent.', input }, 'openai', '/v1/responses');
    const nulled = describe_({ instructions: 'Agent.', conversation: null, input }, 'openai', '/v1/responses');
    expect(omitted.conversation).toEqual(expect.stringMatching(/^[0-9a-f]{64}$/));
    expect(nulled).toEqual(omitted);
    expect(describe_({ instructions: 'Agent.', conversation: 'conv_1', input }, 'openai', '/v1/responses'))
      .toEqual({ endsWithToolResult: true, conversation: STORED_RESPONSE_CONVERSATION });
  });

  describe.each(['rawPredict', 'streamRawPredict'])('Claude on Vertex %s', (method) => {
    const url = `/v1/projects/p/locations/us-east5/publishers/anthropic/models/claude-sonnet-4-5:${method}`;
    const body = (system, task) => ({
      anthropic_version: 'vertex-2023-10-16',
      system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: task }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ],
    });

    test('is a Messages request whose hash includes the system prompt', () => {
      const main = describe_(body('Main agent.', 'Task.'), 'vertex', url);
      const sub = describe_(body('Sub-agent.', 'Task.'), 'vertex', url);
      expect(main).toEqual({ endsWithToolResult: true, conversation: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(describe_(body('Main agent.', 'Task.'), 'vertex', `${url}?alt=sse`)).toEqual(main);
      expect(sub.conversation).not.toBe(main.conversation);
    });

    test('carries the notice after the tool results of the final user message', () => {
      const original = body('Main agent.', 'Task.');
      const steered = JSON.parse(injectSteeringMessage(
        Buffer.from(JSON.stringify(original)), 'vertex', 'NOTICE', url).toString('utf8'));
      expect(steered.system).toBe('Main agent.');
      expect(steered.messages).toHaveLength(3);
      expect(steered.messages[2].content).toEqual([
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'text', text: 'NOTICE' },
      ]);
    });
  });

  describe.each([
    ['openai', 'invoke'],
    ['openai', 'invoke-with-response-stream'],
    ['copilot', 'invoke'],
    ['copilot', 'invoke-with-response-stream'],
  ])('Claude on Bedrock through the %s adapter on /model/<id>/%s', (provider, method) => {
    const body = (system, task) => ({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system,
      messages: [
        { role: 'user', content: [{ type: 'text', text: task }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ],
    });
    const urls = [
      `/model/us.anthropic.claude-sonnet-4-5-20250929-v1:0/${method}`,
      // An application inference profile ARN does not name the model, so the
      // body's anthropic_version identifies the Messages schema.
      `/model/${encodeURIComponent('arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/abc')}/${method}`,
    ];

    test.each(urls)('is a Messages request whose hash includes the system prompt (%s)', (url) => {
      const main = describe_(body('Main agent.', 'Task.'), provider, url);
      const sub = describe_(body('Sub-agent.', 'Task.'), provider, url);
      expect(main).toEqual({ endsWithToolResult: true, conversation: expect.stringMatching(/^[0-9a-f]{64}$/) });
      expect(sub.conversation).not.toBe(main.conversation);
    });

    test.each(urls)('carries the notice after the tool results of the final user message (%s)', (url) => {
      const steered = JSON.parse(injectSteeringMessage(
        Buffer.from(JSON.stringify(body('Main agent.', 'Task.'))), provider, 'NOTICE', url).toString('utf8'));
      expect(steered.system).toBe('Main agent.');
      expect(steered.messages).toHaveLength(3);
      expect(steered.messages[2].content).toEqual([
        { type: 'tool_result', tool_use_id: 't1', content: 'x' },
        { type: 'text', text: 'NOTICE' },
      ]);
    });

    test('recognises a Claude model id by path without anthropic_version', () => {
      const { anthropic_version: _version, ...withoutVersion } = body('Main agent.', 'Task.');
      expect(describe_(withoutVersion, provider, urls[0]).endsWithToolResult).toBe(true);
    });
  });

  test.each([
    ['anthropic', '/v1/messages/count_tokens'],
    ['copilot', '/v1/messages/count_tokens'],
    ['openai', '/v1/responses/input_tokens'],
    ['gemini', '/v1beta/models/gemini-2.5-pro:countTokens'],
    ['vertex', '/v1/projects/p/locations/us-east5/publishers/anthropic/models/count-tokens:rawPredict'],
  ])('never steers %s token-counting request %s', (provider, url) => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Task.' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }] },
      ],
      input: [
        { role: 'user', content: 'Task.' },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'x' },
      ],
      contents: [
        { role: 'user', parts: [{ text: 'Task.' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read', response: {} } }] },
      ],
    };
    expect(describe_(body, provider, url)).toBeNull();
    expect(injectSteeringMessage(Buffer.from(JSON.stringify(body)), provider, 'NOTICE', url)).toBeNull();
  });

  test('gives all Responses requests continuing a stored response one shared conversation', () => {
    expect(describe_({
      previous_response_id: 'resp_1',
      input: [{ type: 'function_call_output', call_id: 'c1', output: 'x' }],
    }, 'openai', '/v1/responses')).toEqual({ endsWithToolResult: true, conversation: STORED_RESPONSE_CONVERSATION });
    expect(describe_({
      instructions: 'Agent.',
      previous_response_id: 'resp_2',
      input: [{ role: 'user', content: 'Task.' }],
    }, 'openai', '/v1/responses')).toEqual({ endsWithToolResult: false, conversation: STORED_RESPONSE_CONVERSATION });
  });

  test.each([
    ['chat tool message', 'openai', '/v1/chat/completions', {
      messages: [
        { role: 'user', content: 'Task.' },
        { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'x' },
      ],
    }, true],
    ['chat user message', 'openai', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'Summarize the conversation.' }],
    }, false],
    ['messages text-only user turn', 'anthropic', '/v1/messages', {
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Task.' }] }],
    }, false],
    ['responses user message', 'openai', '/v1/responses', {
      input: [{ role: 'user', content: 'Task.' }],
    }, false],
    ['gemini function response', 'gemini', '/v1beta/models/m:generateContent', {
      contents: [
        { role: 'user', parts: [{ text: 'Task.' }] },
        { role: 'model', parts: [{ functionCall: { name: 'read', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read', response: {} } }] },
      ],
    }, true],
    ['gemini text turn', 'gemini', '/v1beta/models/m:generateContent', {
      contents: [{ role: 'user', parts: [{ text: 'Task.' }] }],
    }, false],
  ])('detects whether a %s ends with a tool result', (_name, provider, url, body, expected) => {
    expect(describe_(body, provider, url).endsWithToolResult).toBe(expected);
  });

  test('returns null for a body that is not JSON', () => {
    expect(describeSteeringConversation(Buffer.from('not json'), 'openai', '/v1/chat/completions')).toBeNull();
  });
});
