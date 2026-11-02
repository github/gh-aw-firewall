import * as yaml from 'js-yaml';
import { redactComposeServiceEnvironment, sanitizeDockerComposeYaml } from './compose-sanitizer';

describe('compose snapshot environment policy', () => {
  it.each([
    'GH_AW_OTLP_ENDPOINTS',
    'OTEL_EXPORTER_OTLP_HEADERS',
    'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS',
    'DATABASE_URL',
    'WEBHOOK_URL',
    'STORAGE_CONNECTION_STRING',
    'SENTRY_DSN',
    'SERVICE_PASSWORD',
    'SERVICE_AUTH',
    'SERVICE_PAT',
    'SERVICE_CREDENTIALS',
    'OPENAI_API_TARGET',
    'AWF_SENSITIVE_OPENAI_TARGET',
    'AWF_SQUID_CONFIG_B64',
    'FUTURE_SETTING',
    'toString',
  ])('hides %s in both environment forms', name => {
    const raw = yaml.dump({
      services: {
        mapping: { environment: { [name]: 'opaque-canary=a=b\nsecond-line' } },
        list: { environment: [`${name}=opaque-canary=a=b\nsecond-line`] },
      },
    });
    const sanitized = sanitizeDockerComposeYaml(raw);

    expect(sanitized).not.toContain('canary');
    expect(yaml.load(sanitized)).toEqual({
      services: {
        mapping: { environment: { [name]: '[REDACTED]' } },
        list: { environment: [`${name}=[REDACTED]`] },
      },
    });
  });

  it.each([
    ['AWF_CHROOT_ENABLED', 'true'],
    ['AWF_DOH_ENABLED', 'false'],
    ['AWF_SSL_BUMP_ENABLED', 'true'],
    ['OTEL_SDK_DISABLED', 'false'],
    ['OTEL_EXPORTER_OTLP_PROTOCOL', 'grpc'],
    ['OTEL_EXPORTER_OTLP_TRACES_PROTOCOL', 'http/protobuf'],
    ['OTEL_EXPORTER_OTLP_METRICS_PROTOCOL', 'http/json'],
    ['OTEL_EXPORTER_OTLP_LOGS_PROTOCOL', 'http/protobuf'],
  ])('preserves only bounded safe values for %s', (name, value) => {
    const safe = { environment: { [name]: value } };
    const safeList = { environment: [`${name}=${value}`] };
    const unsafe = { environment: { [name]: 'credential-canary' } };
    const unsafeList = { environment: [`${name}=credential-canary`, name] };

    for (const service of [safe, safeList, unsafe, unsafeList]) {
      redactComposeServiceEnvironment(service);
    }

    expect(safe.environment).toEqual({ [name]: value });
    expect(safeList.environment).toEqual([`${name}=${value}`]);
    expect(unsafe.environment).toEqual({ [name]: '[REDACTED]' });
    expect(unsafeList.environment).toEqual([`${name}=[REDACTED]`, `${name}=[REDACTED]`]);
  });

  it.each([
    'awf_chroot_enabled', 'AWF_CHROOT_ENABLED_EXTRA', 'X_AWF_CHROOT_ENABLED',
  ])('does not allow lookalike names: %s', name => {
    const service = { environment: { [name]: 'true' } };
    redactComposeServiceEnvironment(service);
    expect(service.environment).toEqual({ [name]: '[REDACTED]' });
  });

  it.each([
    { label: 'malformed JSON', value: '[{"headers":"canary"' },
    { label: 'an object', value: { headers: 'canary' } },
    { label: 'an array', value: ['canary'] },
    { label: 'a number', value: 12345 },
    { label: 'a boolean', value: true },
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'an empty string', value: '' },
  ])('hides $label without parsing or relying on its type', ({ value }) => {
    const service = { environment: { GH_AW_OTLP_ENDPOINTS: value, OTEL_SDK_DISABLED: value } };
    redactComposeServiceEnvironment(service);
    expect(service.environment).toEqual({
      GH_AW_OTLP_ENDPOINTS: '[REDACTED]', OTEL_SDK_DISABLED: '[REDACTED]',
    });
  });

  it('hides malformed environment values and non-string list entries', () => {
    const scalar = { environment: 'credential-canary' };
    const list = { environment: [12345, null, { FUTURE_SETTING: 'credential-canary' }] };
    redactComposeServiceEnvironment(scalar);
    redactComposeServiceEnvironment(list);
    expect(scalar.environment).toBe('[REDACTED]');
    expect(list.environment).toEqual(['[REDACTED]', '[REDACTED]', '[REDACTED]']);
  });
});
