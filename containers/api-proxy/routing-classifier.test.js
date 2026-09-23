'use strict';

const {
  CLASSIFIER_OUTPUT_TOKENS,
  CLASSIFIER_REASONING_OUTPUT_TOKENS,
  buildClassifierRequest,
  extractClassifierOutput,
  preflightClassifierRequest,
} = require('./routing-classifier');

describe('routing classifier', () => {
  const plan = { system_prompt: 'Classify precisely.', prompt: 'Fix the bug.' };

  it('builds frozen native Responses and Chat Completions requests', () => {
    const responses = buildClassifierRequest(
      { wireModel: 'gpt-test', protocol: 'responses', effort: 'high' }, plan,
    );
    expect(responses).toEqual({
      path: '/responses',
      body: {
        model: 'gpt-test', instructions: plan.system_prompt,
        input: [{ role: 'user', content: plan.prompt }], tools: [], stream: false,
        max_output_tokens: CLASSIFIER_REASONING_OUTPUT_TOKENS, reasoning: { effort: 'high' },
      },
      outputAllowance: CLASSIFIER_REASONING_OUTPUT_TOKENS,
    });
    expect(Object.isFrozen(responses.body)).toBe(true);
    expect(buildClassifierRequest({ wireModel: 'chat-test', protocol: 'chat-completions' }, plan))
      .toMatchObject({ path: '/chat/completions', body: { model: 'chat-test', tools: [], stream: false, max_tokens: CLASSIFIER_OUTPUT_TOKENS } });
  });

  it('fails closed without verified capacity and admits the exact capacity boundary', () => {
    expect(() => preflightClassifierRequest({ wireModel: 'x', protocol: 'responses' }, plan))
      .toThrow(expect.objectContaining({ code: 'routing_configuration_error' }));
    const base = { wireModel: 'x', protocol: 'responses', contextWindow: 100_000 };
    const preflight = preflightClassifierRequest(base, plan);
    expect(preflight.eligible).toBe(true);
    expect(preflightClassifierRequest({ ...base, contextWindow: preflight.requiredTokens }, plan).eligible).toBe(true);
    expect(preflightClassifierRequest({ ...base, contextWindow: preflight.requiredTokens - 1 }, plan).eligible).toBe(false);
  });

  it('extracts only an unambiguous output from native protocol shapes', () => {
    expect(extractClassifierOutput('chat-completions', { choices: [{ message: { content: '{"mode":"balanced"}' } }] }))
      .toBe('{"mode":"balanced"}');
    expect(extractClassifierOutput('responses', { output: [{ content: [{ type: 'output_text', text: 'label' }] }] }))
      .toBe('label');
    expect(extractClassifierOutput('responses', { output: [{ content: [{ type: 'output_text', text: 'one' }, { type: 'output_text', text: 'two' }] }] }))
      .toBeNull();
  });
});
