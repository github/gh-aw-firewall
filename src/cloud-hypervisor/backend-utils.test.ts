import {
  connectivityProbeTimeoutMs,
  createBoundedOutputCollector,
  formatError,
  shellSingleQuote,
} from './backend-utils';

describe('Cloud Hypervisor backend utilities', () => {
  it('formats errors and safely quotes shell arguments', () => {
    expect(formatError(new Error('failed'))).toBe('failed');
    expect(formatError('failed')).toBe('failed');
    expect(shellSingleQuote("it's fine")).toBe(`'it'\\''s fine'`);
  });

  it('budgets connectivity probes for each configured leg', () => {
    expect(connectivityProbeTimeoutMs(0, false)).toBe(216_000);
    expect(connectivityProbeTimeoutMs(2, true)).toBe(654_000);
  });

  it('bounds captured output', () => {
    const collector = createBoundedOutputCollector(4);
    collector.stream.write('abcdef');
    expect(collector.toString()).toBe('abcd');
  });
});
