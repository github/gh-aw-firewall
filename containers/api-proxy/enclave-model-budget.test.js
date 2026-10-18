'use strict';

const crypto = require('crypto');
const {
  createInvocationModelBudget,
  usageTokenCount,
} = require('./enclave-model-budget');

const secret = 'a'.repeat(64);

function capability(invocationId, maxRequests = null, maxTokens = null) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    invocationId,
    maxRequests,
    maxTokens,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(payload)
    .digest('base64url');
  return 'Bearer ' + payload + '.' + signature;
}

function attempt(budget, token, body = Buffer.from('{"model":"test"}'), path = '/v1/chat/completions') {
  return budget.beginAttempt({
    authorization: token,
    method: 'POST',
    path,
    body,
  });
}

describe('invocation-scoped enclave model budgets', () => {
  test('counts each admitted upstream attempt, including retries, against the request ceiling', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-00000001', 2);

    expect(attempt(budget, token).allowed).toBe(true);
    expect(attempt(budget, token).allowed).toBe(true);
    expect(attempt(budget, token)).toMatchObject({ allowed: false, reason: 'request_limit' });
  });

  test('bounds chat and responses output and requires usage for streaming', () => {
    const budget = createInvocationModelBudget(secret);
    const chat = attempt(
      budget,
      capability('invocation-00000002', null, 128),
      Buffer.from('{"model":"test","stream":true}'),
    );
    const chatBody = JSON.parse(chat.body.toString('utf8'));
    expect(chatBody.max_tokens).toBe(128 - Buffer.byteLength('{"model":"test","stream":true}'));
    expect(chatBody.stream_options).toEqual({ include_usage: true });
    chat.settle({ input_tokens: 40, output_tokens: 88, cache_read_tokens: 0, cache_write_tokens: 0 });
    expect(attempt(budget, capability('invocation-00000002', null, 128)))
      .toMatchObject({ allowed: false, reason: 'token_limit' });

    const responses = attempt(
      budget,
      capability('invocation-00000003', null, 128),
      Buffer.from('{"model":"test"}'),
      '/v1/responses',
    );
    expect(JSON.parse(responses.body.toString('utf8')).max_output_tokens).toBe(
      128 - Buffer.byteLength('{"model":"test"}'),
    );
  });

  test('exhausts the budget after over-limit usage and denies subsequent inference', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-00000004', null, 64);
    const first = attempt(budget, token);
    expect(first.allowed).toBe(true);
    first.settle({ input_tokens: 40, output_tokens: 25, cache_read_tokens: 0, cache_write_tokens: 0 });
    expect(attempt(budget, token)).toMatchObject({ allowed: false, reason: 'token_limit' });
  });

  test('reserves token-limited invocations synchronously to reject concurrent inference', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-00000005', 4, 128);
    const first = attempt(budget, token);

    expect(attempt(budget, token)).toMatchObject({
      allowed: false,
      reason: 'token_request_in_flight',
    });
    first.settle({ input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0 });
    expect(attempt(budget, token).allowed).toBe(true);
  });

  test('fails closed on missing usage and isolates accounting between invocations', () => {
    const budget = createInvocationModelBudget(secret);
    const firstToken = capability('invocation-00000006', null, 128);
    const first = attempt(budget, firstToken);
    first.settleMissing();
    expect(attempt(budget, firstToken)).toMatchObject({ allowed: false, reason: 'token_limit' });

    const secondToken = capability('invocation-00000007', null, 128);
    expect(attempt(budget, secondToken).allowed).toBe(true);
  });

  test('does not double-count cached input and rejects invalid capabilities and unsupported token endpoints', () => {
    expect(usageTokenCount({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_write_tokens: 3,
      input_tokens_include_cache: true,
    })).toBe(28);

    const budget = createInvocationModelBudget(secret);
    expect(attempt(budget, '******')).toMatchObject({
      allowed: false,
      reason: 'invalid_capability',
    });
    expect(attempt(
      budget,
      capability('invocation-00000008', null, 128),
      Buffer.from('{}'),
      '/v1/completions',
    )).toMatchObject({ allowed: false, reason: 'unsupported_token_accounting' });
  });
});
