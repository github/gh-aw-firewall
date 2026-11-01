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
  test('leaves repeated inference unbounded and unmodified without optional model ceilings', () => {
    const body = Buffer.from(JSON.stringify({ model: 'test', messages: [
      { role: 'user', content: 'x'.repeat(512) },
    ] }));
    const limited = createInvocationModelBudget(secret);
    expect(attempt(limited, capability('invocation-acceptance01', 1, 256), body)).toEqual({
      allowed: false, reason: 'token_limit', tokenFailure: 'input_reservation',
    });

    const unbounded = createInvocationModelBudget(undefined);
    for (let index = 0; index < 3; index += 1) {
      const result = attempt(unbounded, undefined, body);
      expect(result.allowed).toBe(true);
      expect(result.body).toBeNull();
      result.settleMissing();
    }
  });

  test.each([
    [null, 'body_missing'],
    [Buffer.alloc(128, 'x'), 'input_reservation'],
    [Buffer.from('{'), 'request_json'],
    [Buffer.from('null'), 'request_shape'],
    [Buffer.from('[]'), 'request_shape'],
    [Buffer.from('{"max_tokens":1,"max_completion_tokens":1}'), 'output_conflict'],
    [Buffer.from('{"max_tokens":null}'), 'output_shape'],
    [Buffer.from('{"stream":true,"stream_options":null}'), 'stream_options'],
  ])('classifies token rejection without retaining input (%s)', (body, tokenFailure) => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-diagnostic01', 1, 128);
    expect(attempt(budget, token, body)).toEqual({
      allowed: false, reason: 'token_limit', tokenFailure,
    });
    // Rejected input neither dispatches nor consumes the request allowance.
    expect(attempt(budget, token).allowed).toBe(true);
  });

  test('distinguishes exhausted accounting from rejected request shapes', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-diagnostic02', 2, 128);
    attempt(budget, token).settleMissing();
    expect(attempt(budget, token)).toEqual({
      allowed: false, reason: 'token_limit', tokenFailure: 'budget_exhausted',
    });
  });

  test.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['Basic PRIVATE_CREDENTIAL', 'scheme'],
    ['Bearer PRIVATE_CREDENTIAL', 'format'],
    ['Bearer PRIVATE_PAYLOAD.PRIVATE_SIGNATURE', 'signature'],
  ])('classifies rejected capabilities without returning credential material (%s)', (authorization, failure) => {
    const result = attempt(createInvocationModelBudget(secret), authorization);
    expect(result).toEqual({
      allowed: false, reason: 'invalid_capability', capabilityFailure: failure,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE/);
  });

  test('distinguishes signed invalid claims from a signature mismatch', () => {
    expect(attempt(createInvocationModelBudget(secret), capability('short', 1))).toEqual({
      allowed: false, reason: 'invalid_capability', capabilityFailure: 'claims',
    });
    const changedSecret = createInvocationModelBudget('b'.repeat(64));
    expect(attempt(changedSecret, capability('invocation-00000001', 1))).toEqual({
      allowed: false, reason: 'invalid_capability', capabilityFailure: 'signature',
    });
    const budget = createInvocationModelBudget(secret);
    expect(attempt(budget, capability('invocation-00000001', 1)).allowed).toBe(true);
    expect(attempt(budget, capability('invocation-00000001', 2))).toEqual({
      allowed: false, reason: 'invalid_capability', capabilityFailure: 'claims_changed',
    });
  });

  test('counts each admitted upstream attempt, including retries, against the request ceiling', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-00000001', 2);

    expect(attempt(budget, token).allowed).toBe(true);
    expect(attempt(budget, token).allowed).toBe(true);
    expect(attempt(budget, token)).toMatchObject({ allowed: false, reason: 'request_limit' });
  });

  test('enforces budgets on inference routes below a /models API prefix', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-prefix0001', 1);
    const prefixed = attempt(
      budget,
      token,
      Buffer.from('{"model":"test"}'),
      '/models/chat/completions',
    );

    expect(prefixed.allowed).toBe(true);
    expect(attempt(budget, token, Buffer.from('{}'), '/models/responses'))
      .toMatchObject({ allowed: false, reason: 'request_limit' });

    const tokenBudget = createInvocationModelBudget(secret);
    const bounded = attempt(
      tokenBudget,
      capability('invocation-prefix0002', null, 128),
      Buffer.from('{"model":"test"}'),
      '/models/chat/completions',
    );
    expect(bounded.allowed).toBe(true);
    expect(JSON.parse(bounded.body.toString('utf8')).max_tokens).toBe(
      128 - Buffer.byteLength('{"model":"test"}'),
    );
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
    })).toBe(25);
    expect(usageTokenCount({
      input_tokens: 20,
      output_tokens: 5,
      cache_read_tokens: 20,
      cache_write_tokens: 3,
      input_tokens_include_cache: false,
    })).toBe(48);

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

  test('keeps Responses budgets available when cache writes are included in input tokens', () => {
    const budget = createInvocationModelBudget(secret);
    const token = capability('invocation-cache00001', null, 1200);
    const first = attempt(budget, token, Buffer.from('{"model":"test"}'), '/v1/responses');
    expect(first.allowed).toBe(true);
    first.settle({
      input_tokens: 1000,
      output_tokens: 50,
      cache_read_tokens: 400,
      cache_write_tokens: 300,
      input_tokens_include_cache: true,
    });
    const next = attempt(budget, token, Buffer.from('{"model":"test"}'), '/v1/responses');
    expect(next.allowed).toBe(true);
    expect(JSON.parse(next.body.toString('utf8')).max_output_tokens).toBe(
      150 - Buffer.byteLength('{"model":"test"}'),
    );
  });
});
