import {
  buildRouterOtelEnv,
  isRouterOtelHostEnvVar,
  redactOtlpEnvValue,
} from './router-otel-env';

const SIGNAL_SETTINGS = ['ENDPOINT', 'PROTOCOL', 'HEADERS', 'TIMEOUT', 'CERTIFICATE'];
// The settings the router reads (containers/router/telemetry.go).
const ROUTER_SETTINGS = [
  'OTEL_SERVICE_NAME',
  'OTEL_RESOURCE_ATTRIBUTES',
  'OTEL_SDK_DISABLED',
  'OTEL_TRACES_EXPORTER',
  'OTEL_METRICS_EXPORTER',
  'OTEL_TRACES_SAMPLER',
  'OTEL_TRACES_SAMPLER_ARG',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRIC_EXPORT_TIMEOUT',
  ...SIGNAL_SETTINGS.map(s => `OTEL_EXPORTER_OTLP_${s}`),
  ...SIGNAL_SETTINGS.map(s => `OTEL_EXPORTER_OTLP_TRACES_${s}`),
  ...SIGNAL_SETTINGS.map(s => `OTEL_EXPORTER_OTLP_METRICS_${s}`),
];

describe('router OpenTelemetry settings', () => {
  it('maps exactly the settings the router reads, with values unchanged', () => {
    const hostEnv = Object.fromEntries(ROUTER_SETTINGS.map(name => [`AWF_ROUTER_${name}`, ` value of ${name} `]));
    expect(buildRouterOtelEnv(hostEnv)).toEqual(
      Object.fromEntries(ROUTER_SETTINGS.map(name => [name, ` value of ${name} `])),
    );
  });

  it('reserves the whole AWF_ROUTER_OTEL_* namespace', () => {
    for (const name of [
      ...ROUTER_SETTINGS.map(setting => `AWF_ROUTER_${setting}`),
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_LOGS_HEADERS',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADER',
    ]) {
      expect(isRouterOtelHostEnvVar(name)).toBe(true);
    }
    for (const name of ['OTEL_EXPORTER_OTLP_HEADERS', 'AWF_ROUTER_OTELX', 'AWF_ROUTING_CONFIG', 'X_AWF_ROUTER_OTEL_Y']) {
      expect(isRouterOtelHostEnvVar(name)).toBe(false);
    }
  });

  it('passes values, including any $, unchanged; escaping for Compose is the router service\'s job', () => {
    expect(buildRouterOtelEnv({ AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=a$b${C}' }))
      .toEqual({ OTEL_EXPORTER_OTLP_HEADERS: 'x-api-key=a$b${C}' });
  });

  it('keeps signal-specific and shared settings side by side for the router to resolve', () => {
    expect(buildRouterOtelEnv({
      AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      AWF_ROUTER_OTEL_METRICS_EXPORTER: 'none',
    })).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://collector:4318',
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://traces:4318/v1/traces',
      OTEL_METRICS_EXPORTER: 'none',
    });
  });

  it('ignores blank, unsupported and shared host settings', () => {
    expect(buildRouterOtelEnv({
      AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT: '',
      AWF_ROUTER_OTEL_SERVICE_NAME: '   ',
      AWF_ROUTER_OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
      AWF_ROUTER_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://collector:4318/v1/logs',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://external.example',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20shared',
      OTEL_SERVICE_NAME: 'awf-api-proxy',
      GH_AW_OTLP_ENDPOINTS: '[{"url":"https://external.example"}]',
    })).toEqual({});
  });

  describe('redactOtlpEnvValue', () => {
    it.each([
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_HEADERS',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_HEADERS',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_METRICS_HEADERS',
    ])('redacts %s', name => {
      expect(redactOtlpEnvValue(name, 'authorization=Bearer%20secret')).toBe('[REDACTED]');
    });

    it.each([
      'OTEL_EXPORTER_OTLP_ENDPOINT',
      'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
      'AWF_ROUTER_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
    ])('redacts the user info of %s', name => {
      expect(redactOtlpEnvValue(name, 'https://user:p%40ss@collector:4318/otlp?x=1'))
        .toBe('https://[REDACTED]@collector:4318/otlp?x=1');
      expect(redactOtlpEnvValue(name, 'http://collector:4318/path@v1')).toBe('http://collector:4318/path@v1');
    });

    // Every leading character Go's strings.TrimSpace removes, as the router trims settings.
    it.each([
      ' ', '\t', '\n', '\v', '\f', '\r', '\u0085', '\u00a0', '\u1680', '\u2000', '\u200a',
      '\u2028', '\u2029', '\u202f', '\u205f', '\u3000',
    ].map(space => [JSON.stringify(space), space]))('redacts the user info of an endpoint padded with %s', (_label, space) => {
      const endpoint = `${space}${space}HTTPS://user-canary:pw-canary@collector:4318/v1`;
      expect(redactOtlpEnvValue('AWF_ROUTER_OTEL_EXPORTER_OTLP_ENDPOINT', endpoint))
        .toBe(`${space}${space}HTTPS://[REDACTED]@collector:4318/v1`);
    });

    it('leaves other settings unchanged', () => {
      expect(redactOtlpEnvValue('OTEL_SERVICE_NAME', 'user:pw@x')).toBe('user:pw@x');
      expect(redactOtlpEnvValue('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf')).toBe('http/protobuf');
    });
  });
});
