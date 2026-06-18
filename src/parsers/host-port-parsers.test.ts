import { validateAllowHostPorts, applyHostServicePortsConfig } from './host-port-parsers';

describe('validateAllowHostPorts', () => {
  it('returns valid when allowHostPorts is undefined', () => {
    expect(validateAllowHostPorts(undefined, false)).toEqual({ valid: true });
  });

  it('returns valid when allowHostPorts is set and enableHostAccess is true', () => {
    expect(validateAllowHostPorts('8080', true)).toEqual({ valid: true });
  });

  it('returns error when allowHostPorts is set but enableHostAccess is false', () => {
    expect(validateAllowHostPorts('8080', false)).toEqual({
      valid: false,
      error: '--allow-host-ports requires --enable-host-access to be set',
    });
  });

  it('returns error when allowHostPorts is set and enableHostAccess is undefined', () => {
    expect(validateAllowHostPorts('8080', undefined)).toEqual({
      valid: false,
      error: '--allow-host-ports requires --enable-host-access to be set',
    });
  });

  it('returns valid when both are undefined', () => {
    expect(validateAllowHostPorts(undefined, undefined)).toEqual({ valid: true });
  });
});

describe('applyHostServicePortsConfig', () => {
  const mockLog = () => ({ warn: jest.fn(), info: jest.fn() });

  it('returns valid with unchanged enableHostAccess when allowHostServicePorts is undefined', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig(undefined, false, log);
    expect(result).toEqual({ valid: true, enableHostAccess: false });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns valid and logs when allowHostServicePorts is set with enableHostAccess already true', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('8080,3000', true, log);
    expect(result).toEqual({ valid: true, enableHostAccess: true });
    expect(log.warn).toHaveBeenCalled();
    expect(log.info).toHaveBeenCalled();
  });

  it('auto-enables host access and warns when enableHostAccess is false', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('8080', false, log);
    expect(result).toEqual({ valid: true, enableHostAccess: true });
    const warnCalls = log.warn.mock.calls.map(c => c[0] as string);
    expect(warnCalls.some(msg => msg.includes('automatically enabling'))).toBe(true);
  });

  it('auto-enables host access when enableHostAccess is undefined', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('9000', undefined, log);
    expect(result).toEqual({ valid: true, enableHostAccess: true });
  });

  it('returns error for a non-numeric port', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('not-a-port', false, log);
    expect(result).toEqual({
      valid: false,
      error: 'Invalid port in --allow-host-service-ports: not-a-port. Must be a numeric value',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('returns error for port 0', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('0', false, log);
    expect(result).toEqual({
      valid: false,
      error: 'Invalid port in --allow-host-service-ports: 0. Must be a number between 1 and 65535',
    });
  });

  it('returns error for port > 65535', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('65536', false, log);
    expect(result).toEqual({
      valid: false,
      error: 'Invalid port in --allow-host-service-ports: 65536. Must be a number between 1 and 65535',
    });
  });

  it('accepts port 1 (minimum valid port)', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('1', false, log);
    expect(result.valid).toBe(true);
  });

  it('accepts port 65535 (maximum valid port)', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('65535', false, log);
    expect(result.valid).toBe(true);
  });

  it('logs port info message when ports are valid', () => {
    const log = mockLog();
    applyHostServicePortsConfig('8080,3000', true, log);
    const infoCalls = log.info.mock.calls.map(c => c[0] as string);
    expect(infoCalls.some(msg => msg.includes('8080,3000'))).toBe(true);
  });

  it('returns error for second invalid port in list', () => {
    const log = mockLog();
    const result = applyHostServicePortsConfig('8080,abc', false, log);
    expect(result).toEqual({
      valid: false,
      error: 'Invalid port in --allow-host-service-ports: abc. Must be a numeric value',
    });
  });
});
