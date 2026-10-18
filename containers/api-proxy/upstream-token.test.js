const { EventEmitter } = require('events');
const { setupTokenTracking } = require('./upstream-token');

describe('upstream-token', () => {
  test('extracts request model and wires OTEL usage/span callbacks', () => {
    const trackTokenUsage = jest.fn();
    const otel = {
      setTokenAttributes: jest.fn(),
      setBudgetAttributes: jest.fn(),
      endSpan: jest.fn(),
    };
    const logRequest = jest.fn();

    setupTokenTracking({}, Buffer.from(JSON.stringify({ model: 'gpt-5.4' })), {
      requestId: 'req-1',
      provider: 'copilot',
      req: { url: '/v1/chat/completions' },
      startTime: 123,
      billingInfo: null,
      initiatorSent: null,
      span: { id: 'span-1' },
      isStreaming: true,
      trackTokenUsage,
      sanitizeForLog: (value) => value,
      metrics: { increment: jest.fn(), observe: jest.fn() },
      otel,
      logRequest,
    });

    expect(trackTokenUsage).toHaveBeenCalledWith({}, expect.objectContaining({
      requestId: 'req-1',
      requestModel: 'gpt-5.4',
      path: '/v1/chat/completions',
    }));

    const trackingOptions = trackTokenUsage.mock.calls[0][1];
    trackingOptions.onUsage({ input_tokens: 1, output_tokens: 2, total_tokens: 3 }, 'gpt-5.4');
    trackingOptions.onSpanEnd(200);

    expect(otel.setTokenAttributes).toHaveBeenCalledWith(
      { id: 'span-1' },
      expect.objectContaining({ provider: 'copilot', model: 'gpt-5.4', streaming: true }),
    );
    expect(otel.setBudgetAttributes).toHaveBeenCalled();
    expect(otel.endSpan).toHaveBeenCalledWith({ id: 'span-1' }, 200);
  });

  test('settles enclave usage only through the token tracker finalizer', () => {
    const trackTokenUsage = jest.fn();
    const res = new EventEmitter();
    const budgetAttempt = {
      settle: jest.fn(),
      settleMissing: jest.fn(),
    };
    const req = {
      url: '/v1/chat/completions',
      awfEnclaveModelBudgetAttempt: budgetAttempt,
    };

    setupTokenTracking({}, Buffer.from('{}'), {
      requestId: 'req-close',
      provider: 'openai',
      req,
      res,
      startTime: Date.now(),
      billingInfo: null,
      initiatorSent: null,
      span: {},
      isStreaming: true,
      trackTokenUsage,
      sanitizeForLog: (value) => value,
      metrics: { increment: jest.fn(), observe: jest.fn() },
      otel: {
        setTokenAttributes: jest.fn(),
        setBudgetAttributes: jest.fn(),
        endSpan: jest.fn(),
      },
      logRequest: jest.fn(),
    });

    res.emit('close');
    expect(budgetAttempt.settleMissing).not.toHaveBeenCalled();

    const trackingOptions = trackTokenUsage.mock.calls[0][1];
    trackingOptions.onUsage({ input_tokens: 15, output_tokens: 0 }, 'gpt-5.4');
    expect(budgetAttempt.settle).toHaveBeenCalledWith({
      input_tokens: 15,
      output_tokens: 0,
    });
    expect(budgetAttempt.settleMissing).not.toHaveBeenCalled();
  });
});
