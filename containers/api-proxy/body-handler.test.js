const { createBodyHandler } = require('./body-handler');
const { APPLY_PATCH_FUNCTION_TOOL, CodexCompatibilityError } = require('./codex-compat');

function json(buffer) {
  return JSON.parse(buffer.toString('utf8'));
}

describe('transformRequestBody Codex custom-tool translation routing', () => {
  const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });

  test.each(['/chat/completions', '/v1/chat/completions', '/chat/completions/?x=1'])(
    'passes Chat Completions custom tools through unchanged on %s',
    async (url) => {
      const tools = [{ type: 'custom', custom: { name: 'bash' } }];
      const body = Buffer.from(JSON.stringify({ tools }));

      const result = await transformRequestBody(body, 'copilot', { method: 'POST', url }, 'req-1', null);

      expect(result.codexCompatibility).toBeNull();
      expect(json(result.body).tools).toEqual(tools);
    },
  );

  test('still translates Responses apply_patch custom tools', async () => {
    const body = Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'apply_patch', format: { type: 'text' } }],
      input: 'edit a file',
    }));

    const result = await transformRequestBody(body, 'copilot', { method: 'POST', url: '/responses' }, 'req-2', null);

    expect(result.codexCompatibility.customTools.has('apply_patch')).toBe(true);
    expect(json(result.body).tools).toEqual([APPLY_PATCH_FUNCTION_TOOL]);
  });

  test('still rejects unsupported Responses custom tools', async () => {
    const body = Buffer.from(JSON.stringify({
      tools: [{ type: 'custom', name: 'freeform_shell' }],
      input: 'run',
    }));

    await expect(
      transformRequestBody(body, 'copilot', { method: 'POST', url: '/v1/responses' }, 'req-3', null),
    ).rejects.toThrow(CodexCompatibilityError);
  });
});
