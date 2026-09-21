'use strict';

const { createRoutingError, toRoutingFailure } = require('./routing-errors');

describe('routing failures', () => {
  it('emits the exact closed record with bounded sanitized detail', () => {
    const error = createRoutingError('provider_unavailable', `unsafe\r\n${'x'.repeat(600)}`);

    const failure = toRoutingFailure(error);

    expect(failure).toEqual({
      schema: 'awf-routing-failure/v1',
      code: 'provider_unavailable',
      detail: `unsafe${'x'.repeat(494)}`,
      retryable: false,
    });
    expect(failure.detail).toHaveLength(500);
    expect(Object.isFrozen(failure)).toBe(true);
  });

  it('bounds malformed upstream reason codes without changing native identifiers', () => {
    expect(createRoutingError('ai_credits_limit_exceeded').code)
      .toBe('ai_credits_limit_exceeded');

    const malformed = createRoutingError(`bad code\n${'x'.repeat(200)}`);
    expect(malformed.code).toMatch(/^[A-Za-z0-9_.-]+$/);
    expect(malformed.code).toHaveLength(100);
  });

  it('does not expose plain Error details', () => {
    const error = new Error('secret prompt text should not be echoed');
    error.code = 'secret-bearing-provider-code';

    expect(toRoutingFailure(error)).toEqual({
      schema: 'awf-routing-failure/v1',
      code: 'routing_configuration_error',
      detail: 'Model routing failed',
      retryable: false,
    });
  });
});
