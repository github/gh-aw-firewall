'use strict';

const { createAllAdapters } = require('./index');

describe('createAllAdapters', () => {
  it('creates providers in port order and wires each transform to its provider', () => {
    const transforms = {
      openaiBodyTransform: jest.fn(),
      anthropicBodyTransform: jest.fn(),
      copilotBodyTransform: jest.fn(),
      geminiBodyTransform: jest.fn(),
      vertexBodyTransform: jest.fn(),
    };

    const adapters = createAllAdapters({
      OPENAI_API_KEY: 'openai-key',
      ANTHROPIC_API_KEY: 'anthropic-key',
      COPILOT_GITHUB_TOKEN: 'copilot-token',
      GEMINI_API_KEY: 'gemini-key',
      GOOGLE_API_KEY: 'vertex-key',
    }, transforms);

    expect(adapters.map(({ name, port }) => ({ name, port }))).toEqual([
      { name: 'openai', port: 10000 },
      { name: 'anthropic', port: 10001 },
      { name: 'copilot', port: 10002 },
      { name: 'gemini', port: 10003 },
      { name: 'vertex', port: 10004 },
    ]);
    expect(adapters.map(adapter => adapter.getBodyTransform())).toEqual([
      transforms.openaiBodyTransform,
      transforms.anthropicBodyTransform,
      expect.any(Function),
      transforms.geminiBodyTransform,
      transforms.vertexBodyTransform,
    ]);

    const copilotBody = Buffer.from('{}');
    transforms.copilotBodyTransform.mockReturnValue(null);
    adapters[2].getBodyTransform()(copilotBody);
    expect(transforms.copilotBodyTransform).toHaveBeenCalledWith(copilotBody);
  });
});
