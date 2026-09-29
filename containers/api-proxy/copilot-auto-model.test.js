const { createCopilotAdapter } = require('./providers/copilot');
const { createBodyHandler } = require('./body-handler');

function parseBody(body) {
  return JSON.parse(body.toString('utf8'));
}

describe('Copilot auto model handling', () => {
  const { transformRequestBody } = createBodyHandler({ handleRequestError() {}, otel: {} });

  async function transform(adapter, model, url = '/chat/completions') {
    const body = Buffer.from(JSON.stringify({ model, messages: [] }));
    const req = { method: 'POST', url };
    const result = await transformRequestBody(body, 'copilot', req, 'req-1', adapter.getBodyTransform());
    return parseBody(result.body);
  }

  it.each(['auto', 'copilot/auto'])('omits %s on GitHub Copilot chat completions', async (model) => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' });

    expect(await transform(adapter, model)).toEqual({ messages: [] });
  });

  it('preserves concrete models', async () => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' });

    expect(await transform(adapter, 'gpt-5.3-codex')).toEqual({
      model: 'gpt-5.3-codex',
      messages: [],
    });
  });

  it('preserves auto for custom BYOK targets', async () => {
    const adapter = createCopilotAdapter({
      COPILOT_PROVIDER_API_KEY: 'test-key',
      COPILOT_API_TARGET: 'router.example.com',
    });

    expect(await transform(adapter, 'auto')).toEqual({ model: 'auto', messages: [] });
  });

  it('preserves auto on the dedicated Copilot auto endpoint', async () => {
    const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' });

    expect(await transform(adapter, 'auto', '/auto')).toEqual({ model: 'auto', messages: [] });
  });
});
