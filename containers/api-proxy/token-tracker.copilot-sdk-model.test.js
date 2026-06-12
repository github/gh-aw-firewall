/**
 * Regression test: Copilot SDK streaming responses may omit the `model` field
 * in SSE data chunks, causing AI credits to be silently dropped.
 *
 * Bug description:
 * When Copilot CLI runs inside the AWF agent container (copilot-sdk mode),
 * it sends requests through api-proxy port 10002. The upstream Copilot API
 * returns OpenAI-compatible streaming SSE. However, the streaming chunks
 * may NOT include a top-level `model` field. The token tracker then falls
 * back to model='unknown', which has no pricing entry, causing
 * calculateAiCredits() to return null and AI credits to not be tracked.
 *
 * This results in GH_AW_AIC being empty at the end of the run — the exact
 * behavior observed in production (gh-aw run #27371175049).
 *
 * Expected fix: The token tracker should extract the model from the request
 * body (which always contains it) as a fallback when the response doesn't
 * include it.
 */

'use strict';

require('./test-helpers/token-tracker-setup');

const { EventEmitter } = require('events');
const {
  trackTokenUsage,
  closeLogStream,
} = require('./token-tracker');

afterAll(async () => {
  await closeLogStream();
});

describe('Copilot SDK model extraction gap', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.AWF_MAX_AI_CREDITS = process.env.AWF_MAX_AI_CREDITS;
    savedEnv.AWF_DEFAULT_AI_CREDITS_PRICING = process.env.AWF_DEFAULT_AI_CREDITS_PRICING;
  });

  afterEach(() => {
    // Restore env to pre-test state
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  });

  /**
   * Simulates the Copilot API streaming response format as observed when
   * Copilot CLI is the intermediary. The usage chunk includes token counts
   * but the `model` field is absent from the SSE data.
   */
  test('streaming response without model field should still resolve a real model name', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };
    let onUsageCalledWith = null;

    trackTokenUsage(proxyRes, {
      requestId: 'test-copilot-sdk-no-model',
      provider: 'copilot',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
      onUsage: (normalizedUsage, model) => {
        onUsageCalledWith = { normalizedUsage, model };
        return null;
      },
    });

    // Copilot API streaming response: usage chunk WITHOUT model field.
    // This is what we observe in production when Copilot CLI proxies through.
    const chunk1 = 'data: ' + JSON.stringify({
      id: 'chatcmpl-abc123',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
      // NOTE: no `model` field
    }) + '\n\n';

    const chunk2 = 'data: ' + JSON.stringify({
      id: 'chatcmpl-abc123',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 800, total_tokens: 2300 },
      // NOTE: no `model` field in the usage chunk either
    }) + '\n\ndata: [DONE]\n\n';

    proxyRes.emit('data', Buffer.from(chunk1));
    proxyRes.emit('data', Buffer.from(chunk2));
    proxyRes.emit('end');

    setTimeout(() => {
      try {
        // Tokens ARE tracked (metrics increment works)
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'input_tokens_total',
          { provider: 'copilot' },
          1500,
        );
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'output_tokens_total',
          { provider: 'copilot' },
          800,
        );

        // The model should NOT fall back to 'unknown' — it should be resolved
        // from the request body or another source so AI credits can be computed.
        expect(onUsageCalledWith).not.toBeNull();
        expect(onUsageCalledWith.model).not.toBe('unknown');

        done();
      } catch (e) { done(e); }
    }, 50);
  });

  /**
   * Contrast: when the model IS present in SSE chunks (normal case),
   * AI credits work correctly.
   */
  test('streaming response WITH model field correctly identifies the model', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'text/event-stream' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };
    let onUsageCalledWith = null;

    trackTokenUsage(proxyRes, {
      requestId: 'test-copilot-sdk-with-model',
      provider: 'copilot',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
      onUsage: (normalizedUsage, model) => {
        onUsageCalledWith = { normalizedUsage, model };
        return null;
      },
    });

    // Normal case: model field IS present in SSE chunks
    const chunk1 = 'data: ' + JSON.stringify({
      id: 'chatcmpl-def456',
      object: 'chat.completion.chunk',
      model: 'claude-sonnet-4-20250514',
      choices: [{ index: 0, delta: { content: 'Hi' }, finish_reason: null }],
    }) + '\n\n';

    const chunk2 = 'data: ' + JSON.stringify({
      id: 'chatcmpl-def456',
      object: 'chat.completion.chunk',
      model: 'claude-sonnet-4-20250514',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1500, completion_tokens: 800, total_tokens: 2300 },
    }) + '\n\ndata: [DONE]\n\n';

    proxyRes.emit('data', Buffer.from(chunk1));
    proxyRes.emit('data', Buffer.from(chunk2));
    proxyRes.emit('end');

    setTimeout(() => {
      try {
        expect(onUsageCalledWith).not.toBeNull();
        // Model is correctly extracted — AI credits will work
        expect(onUsageCalledWith.model).toBe('claude-sonnet-4-20250514');
        done();
      } catch (e) { done(e); }
    }, 50);
  });

  /**
   * Non-streaming variant: Copilot API returns JSON without model field.
   * Same bug manifests for non-streaming responses.
   */
  test('non-streaming response without model field should still resolve a real model name', (done) => {
    const proxyRes = new EventEmitter();
    proxyRes.headers = { 'content-type': 'application/json' };
    proxyRes.statusCode = 200;

    const metricsRef = { increment: jest.fn() };
    let onUsageCalledWith = null;

    trackTokenUsage(proxyRes, {
      requestId: 'test-copilot-sdk-no-model-json',
      provider: 'copilot',
      path: '/v1/chat/completions',
      startTime: Date.now(),
      metrics: metricsRef,
      onUsage: (normalizedUsage, model) => {
        onUsageCalledWith = { normalizedUsage, model };
        return null;
      },
    });

    // Non-streaming response without model field
    const body = JSON.stringify({
      id: 'chatcmpl-ghi789',
      object: 'chat.completion',
      // NOTE: no `model` field
      choices: [{ index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 250 },
    });

    proxyRes.emit('data', Buffer.from(body));
    proxyRes.emit('end');

    setTimeout(() => {
      try {
        expect(metricsRef.increment).toHaveBeenCalledWith(
          'input_tokens_total',
          { provider: 'copilot' },
          200,
        );

        // The model should NOT fall back to 'unknown'
        expect(onUsageCalledWith).not.toBeNull();
        expect(onUsageCalledWith.model).not.toBe('unknown');

        done();
      } catch (e) { done(e); }
    }, 50);
  });

  /**
   * End-to-end AI credits impact: demonstrates that when model='unknown',
   * the AI credits guard produces no result (null), meaning credits are
   * not tracked for the run.
   */
  test('AI credits guard should compute credits even when response omits model', () => {
    // Reset state
    const { resetAiCreditsGuardForTests, applyAiCreditsUsage } = require('./guards/ai-credits-guard');
    resetAiCreditsGuardForTests();

    // Set a max so the guard is active
    process.env.AWF_MAX_AI_CREDITS = '100';
    delete process.env.AWF_DEFAULT_AI_CREDITS_PRICING;

    const normalizedUsage = {
      input_tokens: 1500,
      output_tokens: 800,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };

    // With a known model, credits are calculated
    const resultKnown = applyAiCreditsUsage(normalizedUsage, 'claude-sonnet-4-20250514');
    expect(resultKnown).not.toBeNull();
    expect(resultKnown.aiCreditsThisResponse).toBeGreaterThan(0);

    // With 'unknown' model, credits should STILL be computed (not silently dropped).
    // Today this returns null — 1500 input + 800 output tokens go completely untracked.
    resetAiCreditsGuardForTests();
    const resultUnknown = applyAiCreditsUsage(normalizedUsage, 'unknown');
    expect(resultUnknown).not.toBeNull();
    expect(resultUnknown.aiCreditsThisResponse).toBeGreaterThan(0);

    // Cleanup
    delete process.env.AWF_MAX_AI_CREDITS;
    resetAiCreditsGuardForTests();
  });
});
