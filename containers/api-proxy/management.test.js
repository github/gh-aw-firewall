'use strict';

const { buildRoutingModelMetadata } = require('./management');

describe('routing metadata in /reflect', () => {
  it('combines discovered IDs with maintained provider metadata and marks incomplete models', () => {
    expect(buildRoutingModelMetadata('openai', ['gpt-5.4', 'o3'], [])).toEqual([
      {
        model_id: 'gpt-5.4',
        source: 'maintained',
        supported_endpoints: ['chat_completions', 'responses'],
        supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
        context_window_tokens: 1_050_000,
        candidate_metadata_complete: true,
      },
      {
        model_id: 'o3',
        source: 'incomplete',
        supported_endpoints: ['chat_completions', 'responses'],
        supported_reasoning_efforts: null,
        context_window_tokens: null,
        candidate_metadata_complete: false,
      },
    ]);
  });

  it('prefers runtime metadata while retaining maintained values where runtime fields are absent', () => {
    expect(buildRoutingModelMetadata('anthropic', ['claude-opus-5-5'], [{
      id: 'claude-opus-5-5',
      supportedEndpoints: ['/v1/messages'],
      capabilities: { limits: { max_context_window_tokens: 900_000 } },
    }])).toEqual([{
      model_id: 'claude-opus-5-5',
      source: 'provider+maintained',
      supported_endpoints: ['/v1/messages'],
      supported_reasoning_efforts: ['low', 'medium', 'high', 'max'],
      context_window_tokens: 900_000,
      candidate_metadata_complete: true,
    }]);
  });

  it('returns null until model discovery provides IDs', () => {
    expect(buildRoutingModelMetadata('openai', null, [])).toBeNull();
  });
});
