import {
  buildRouterOtelEnv,
  redactOtlpEnvValue,
  ROUTER_OTEL_HOST_ENV_VARS,
  ROUTER_OTEL_SETTINGS,
} from './router-otel-env';

describe('router OpenTelemetry settings', () => {
  it('supports exactly the settings the router reads', () => {
    const signalSettings = ['ENDPOINT', 'PROTOCOL', 'HEADERS', 'TIMEOUT', 'CERTIFICATE'];
    expect([...ROUTER_OTEL_SETTINGS].sort()).toEqual([
      'OTEL_SERVICE_NAME',
      'OTEL_RESOURCE_ATTRIBUTES',
      'OTEL_SDK_DISABLED',
      'OTEL_TRACES_EXPORTER',
      'OTEL_METRICS_EXPORTER',
      'OTEL_TRACES_SAMPLER',
      'OTEL_TRACES_SAMPLER_ARG',
      'OTEL_METRIC_EXPORT_INTERVAL',
      'OTEL_METRIC_EXPORT_TIMEOUT',
      ...signalSettings.map(s => `OTEL_EXPORTER_OTLP_${s}`),
      ...signalSettings.map(s => `OTEL_EXPORTER_OTLP_TRACES_${s}`),
      ...signalSettings.map(s => `OTEL_EXPORTER_OTLP_METRICS_${s}`),
    ].sort());
    expect(ROUTER_OTEL_HOST_ENV_VARS).toEqual(ROUTER_OTEL_SETTINGS.map(name => `AWF_ROUTER_${name}`));
  });

  it('maps every set AWF_ROUTER_OTEL_* variable to the router OTEL_* name unchanged', () => {
    const hostEnv = Object.fromEntries(ROUTER_OTEL_SETTINGS.map(name => [`AWF_ROUTER_${name}`, ` value of ${name} `]));
    expect(buildRouterOtelEnv(hostEnv)).toEqual(
      Object.fromEntries(ROUTER_OTEL_SETTINGS.map(name => [name, ` value of ${name} `])),
    );
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

    it('leaves other settings unchanged', () => {
      expect(redactOtlpEnvValue('OTEL_SERVICE_NAME', 'user:pw@x')).toBe('user:pw@x');
      expect(redactOtlpEnvValue('OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf')).toBe('http/protobuf');
    });
  });
});
