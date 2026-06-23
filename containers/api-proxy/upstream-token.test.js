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
});
