import * as path from 'path';
import {
  assertAppleContainerCapability,
  assertAppleContainerCpuCount,
  assertAppleContainerEnvName,
  assertAppleContainerEnvValue,
  assertAppleContainerId,
  assertAppleContainerImageReference,
  assertAppleContainerLabelValue,
  assertAppleContainerLineCount,
  assertAppleContainerLogWindow,
  assertAppleContainerMemorySize,
  assertAppleContainerNetworkName,
  assertAppleContainerPath,
  assertAppleContainerSignal,
  assertAppleContainerStopTimeout,
} from './validation';

describe('assertAppleContainerId', () => {
  it.each(['ab', 'awf-agent', 'my-container_1.2', 'ABC', 'a'.repeat(63)])(
    'accepts %s',
    (value) => {
      expect(assertAppleContainerId(value)).toBe(value);
    },
  );

  it('accepts a generated lowercase UUID', () => {
    const uuid = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
    expect(assertAppleContainerId(uuid)).toBe(uuid);
  });

  it.each([
    ['a single character', 'a'],
    ['a leading hyphen', '-bad'],
    ['a leading dot', '.bad'],
    ['an embedded space', 'a b'],
    ['a slash', 'a/b'],
    ['64 characters', 'a'.repeat(64)],
    ['an empty string', ''],
  ])('rejects %s', (_label, value) => {
    expect(() => assertAppleContainerId(value)).toThrow(/container ID/);
  });

  it('rejects control characters', () => {
    expect(() => assertAppleContainerId('ab\u0007c')).toThrow(/control characters/);
  });

  it('uses the supplied label in the error', () => {
    expect(() => assertAppleContainerId('-x', 'container name')).toThrow(/container name/);
  });
});

describe('assertAppleContainerImageReference', () => {
  it.each([
    'ubuntu:22.04',
    'ghcr.io/github/gh-aw-firewall/agent:latest',
    'ghcr.io/o/r@sha256:0123456789abcdef',
  ])('accepts %s', (value) => {
    expect(assertAppleContainerImageReference(value)).toBe(value);
  });

  it('rejects an option-like reference so it cannot be parsed as a flag', () => {
    expect(() => assertAppleContainerImageReference('--rm')).toThrow(/must not begin with "-"/);
  });

  it.each(['ubuntu 22.04', 'ubuntu;rm', 'ubuntu,latest', 'ubuntu\nlatest'])(
    'rejects %j',
    (value) => {
      expect(() => assertAppleContainerImageReference(value)).toThrow();
    },
  );

  it('rejects an absurdly long reference', () => {
    expect(() => assertAppleContainerImageReference(`a${'b'.repeat(512)}`)).toThrow(
      /not a valid OCI reference/,
    );
  });
});

describe('assertAppleContainerPath', () => {
  it('accepts an absolute normalized path', () => {
    expect(assertAppleContainerPath('/workspace/repo', 'mount source', [])).toBe('/workspace/repo');
  });

  it('rejects a relative path', () => {
    expect(() => assertAppleContainerPath('workspace', 'mount source', [])).toThrow(
      /absolute POSIX path/,
    );
  });

  it.each(['/workspace/../etc', '/workspace//repo', '/workspace/./repo', '/workspace/'])(
    'rejects the unnormalized path %s',
    (value) => {
      expect(() => assertAppleContainerPath(value, 'mount source', [])).toThrow(
        /normalized path/,
      );
    },
  );

  it('rejects a comma when building a comma-delimited --mount token', () => {
    expect(() =>
      assertAppleContainerPath('/work,readonly', 'mount source', [',', '=']),
    ).toThrow(/must not contain ","/);
  });

  it('rejects an equals sign when building a key=value --mount token', () => {
    expect(() =>
      assertAppleContainerPath('/work=x', 'mount source', [',', '=']),
    ).toThrow(/must not contain "="/);
  });

  it('rejects a colon when building a colon-delimited --publish-socket token', () => {
    expect(() =>
      assertAppleContainerPath('/run/a:/etc/passwd', 'socket host path', [':']),
    ).toThrow(/must not contain ":"/);
  });

  it('allows a comma when the token is not comma-delimited', () => {
    expect(assertAppleContainerPath('/work,dir', 'read-only path', [])).toBe('/work,dir');
  });

  it('rejects a path beyond the byte limit', () => {
    const long = path.posix.join('/', 'a'.repeat(5000));
    expect(() => assertAppleContainerPath(long, 'mount source', [])).toThrow(/exceeds 4096 bytes/);
  });
});

describe('environment validation', () => {
  it.each(['PATH', '_HOME', 'A1_B'])('accepts the name %s', (value) => {
    expect(assertAppleContainerEnvName(value)).toBe(value);
  });

  it.each(['1BAD', 'has-dash', 'has space', 'has=equals', ''])('rejects the name %j', (value) => {
    expect(() => assertAppleContainerEnvName(value)).toThrow();
  });

  it('allows an equals sign inside a value', () => {
    expect(assertAppleContainerEnvValue('OPTS', 'a=b=c')).toBe('a=b=c');
  });

  it('allows an empty value', () => {
    expect(assertAppleContainerEnvValue('EMPTY', '')).toBe('');
  });

  it.each(['line\nbreak', 'carriage\rreturn', 'nul\u0000byte'])(
    'rejects the value %j',
    (value) => {
      expect(() => assertAppleContainerEnvValue('KEY', value)).toThrow(/NUL or newlines/);
    },
  );
});

describe('assertAppleContainerLabelValue', () => {
  it('accepts a plain value', () => {
    expect(assertAppleContainerLabelValue('awf', 'agent')).toBe('agent');
  });

  it('accepts an empty value', () => {
    expect(assertAppleContainerLabelValue('awf', '')).toBe('');
  });

  it('rejects an equals sign, which --label does not tolerate even though --env does', () => {
    expect(() => assertAppleContainerLabelValue('awf', 'a=b')).toThrow(/must not contain "="/);
    expect(assertAppleContainerEnvValue('awf', 'a=b')).toBe('a=b');
  });

  it.each(['line\nbreak', 'nul\u0000byte'])('rejects the value %j', (value) => {
    expect(() => assertAppleContainerLabelValue('awf', value)).toThrow(/NUL or newlines/);
  });
});

describe('assertAppleContainerCapability', () => {
  it.each(['CAP_NET_RAW', 'NET_RAW', 'ALL', 'cap_net_raw'])('accepts %s', (value) => {
    expect(assertAppleContainerCapability(value)).toBe(value);
  });

  it.each(['NET RAW', 'NET;RAW', '1NET', ''])('rejects %j', (value) => {
    expect(() => assertAppleContainerCapability(value)).toThrow();
  });
});

describe('resource validation', () => {
  it('accepts a positive integer CPU count', () => {
    expect(assertAppleContainerCpuCount(4)).toBe(4);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the CPU count %p',
    (value) => {
      expect(() => assertAppleContainerCpuCount(value)).toThrow(/positive integer/);
    },
  );

  it.each(['1024', '8G', '512M', '2T'])('accepts the memory size %s', (value) => {
    expect(assertAppleContainerMemorySize(value)).toBe(value);
  });

  it.each(['0', '8g', '8GB', '-1G', '8.5G', ''])('rejects the memory size %j', (value) => {
    expect(() => assertAppleContainerMemorySize(value)).toThrow();
  });
});

describe('network name validation', () => {
  it.each(['default', 'none', 'awf-net', 'n'])('accepts %s', (value) => {
    expect(assertAppleContainerNetworkName(value)).toBe(value);
  });

  it.each(['-net', 'net,mac=00:11:22:33:44:55', 'net work', ''])('rejects %j', (value) => {
    expect(() => assertAppleContainerNetworkName(value)).toThrow();
  });
});

describe('signal and stop-timeout validation', () => {
  it.each(['KILL', 'TERM', 'SIGTERM', 'USR1'])('accepts the signal %s', (value) => {
    expect(assertAppleContainerSignal(value)).toBe(value);
  });

  it.each(['kill', '9', 'TERM;ls', ''])('rejects the signal %j', (value) => {
    expect(() => assertAppleContainerSignal(value)).toThrow();
  });

  it.each([0, 5, 86_400])('accepts the stop timeout %p', (value) => {
    expect(assertAppleContainerStopTimeout(value)).toBe(value);
  });

  it.each([-1, 1.5, 86_401])('rejects the stop timeout %p', (value) => {
    expect(() => assertAppleContainerStopTimeout(value)).toThrow(/0\.\.86400/);
  });
});

describe('log bound validation', () => {
  it.each(['5m', '1h', '2d', '30'])('accepts the log window %s', (value) => {
    expect(assertAppleContainerLogWindow(value)).toBe(value);
  });

  it.each(['5min', '0m', '-5m', 'm', ''])('rejects the log window %j', (value) => {
    expect(() => assertAppleContainerLogWindow(value)).toThrow();
  });

  it.each([1, 2000, 100_000])('accepts the line count %p', (value) => {
    expect(assertAppleContainerLineCount(value)).toBe(value);
  });

  it.each([0, -1, 1.5, 100_001])('rejects the line count %p', (value) => {
    expect(() => assertAppleContainerLineCount(value)).toThrow(/1\.\.100000/);
  });
});
