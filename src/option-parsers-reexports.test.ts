import * as optionParsers from './option-parsers';
import * as dnsParsers from './parsers/dns-parsers';
import * as envParsers from './parsers/env-parsers';
import * as hostPortParsers from './parsers/host-port-parsers';
import * as rateLimitParsers from './parsers/rate-limit-parsers';
import * as shellUtils from './parsers/shell-utils';
import * as volumeParsers from './parsers/volume-parsers';

describe('option parser facade re-exports', () => {
  it('re-exports parser module functions directly', () => {
    expect(optionParsers.buildRateLimitConfig).toBe(rateLimitParsers.buildRateLimitConfig);
    expect(optionParsers.validateRateLimitFlags).toBe(rateLimitParsers.validateRateLimitFlags);
    expect(optionParsers.validateEnableTokenSteeringFlag).toBe(rateLimitParsers.validateEnableTokenSteeringFlag);

    expect(optionParsers.validateAllowHostPorts).toBe(hostPortParsers.validateAllowHostPorts);
    expect(optionParsers.validateAllowHostServicePorts).toBe(hostPortParsers.validateAllowHostServicePorts);
    expect(optionParsers.applyHostServicePortsConfig).toBe(hostPortParsers.applyHostServicePortsConfig);

    expect(optionParsers.parseDnsServers).toBe(dnsParsers.parseDnsServers);
    expect(optionParsers.parseDnsOverHttps).toBe(dnsParsers.parseDnsOverHttps);
    expect(optionParsers.processLocalhostKeyword).toBe(dnsParsers.processLocalhostKeyword);

    expect(optionParsers.escapeShellArg).toBe(shellUtils.escapeShellArg);
    expect(optionParsers.joinShellArgs).toBe(shellUtils.joinShellArgs);

    expect(optionParsers.parseEnvironmentVariables).toBe(envParsers.parseEnvironmentVariables);
    expect(optionParsers.parseVolumeMounts).toBe(volumeParsers.parseVolumeMounts);
  });
});
