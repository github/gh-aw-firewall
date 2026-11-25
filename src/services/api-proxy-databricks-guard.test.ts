import { assertDatabricksTargetsMatchWorkspace } from './api-proxy-databricks-guard';

describe('Databricks target workspace guard', () => {
  const workspace = new URL('https://workspace.cloud.databricks.com');
  const targetKeys = [
    'OPENAI_API_TARGET', 'ANTHROPIC_API_TARGET', 'COPILOT_API_TARGET',
    'GEMINI_API_TARGET', 'VERTEX_API_TARGET', 'COPILOT_PROVIDER_BASE_URL',
  ];

  it('accepts absent and empty targets without mutating the inputs', () => {
    const targets = Object.freeze({ OPENAI_API_TARGET: '' });
    expect(assertDatabricksTargetsMatchWorkspace(targets, workspace)).toBeUndefined();
    expect(targets).toEqual({ OPENAI_API_TARGET: '' });
    expect(workspace.href).toBe('https://workspace.cloud.databricks.com/');
    expect(assertDatabricksTargetsMatchWorkspace({}, workspace)).toBeUndefined();
  });

  it.each(targetKeys)('accepts matching workspace paths for %s', key => {
    const targets = Object.freeze({ [key]: `${workspace.origin}/serving-endpoints/model` });
    expect(() => assertDatabricksTargetsMatchWorkspace(targets, workspace)).not.toThrow();
    expect(() => assertDatabricksTargetsMatchWorkspace({ [key]: workspace.host }, workspace)).not.toThrow();
  });

  it.each(targetKeys)('rejects a conflicting origin for %s', key => {
    expect(() => assertDatabricksTargetsMatchWorkspace({ [key]: 'other.example.com' }, workspace))
      .toThrow('Databricks API target must match the configured HTTPS workspace origin');
  });

  it('checks every selected target, not only the first matching one', () => {
    expect(() => assertDatabricksTargetsMatchWorkspace({
      OPENAI_API_TARGET: workspace.host,
      COPILOT_PROVIDER_BASE_URL: 'https://other.example.com/v1',
    }, workspace)).toThrow('Databricks API target must match the configured HTTPS workspace origin');
  });

  it('matches HTTPS origins including the effective port', () => {
    expect(() => assertDatabricksTargetsMatchWorkspace({
      OPENAI_API_TARGET: `${workspace.host}:443`,
    }, workspace)).not.toThrow();
    expect(() => assertDatabricksTargetsMatchWorkspace({
      OPENAI_API_TARGET: `${workspace.host}:8443`,
    }, new URL(`${workspace.origin}:8443/`))).not.toThrow();
    expect(() => assertDatabricksTargetsMatchWorkspace({
      OPENAI_API_TARGET: `${workspace.host}:8443`,
    }, workspace)).toThrow('Databricks API target must match the configured HTTPS workspace origin');
  });

  it.each([
    `http://${workspace.host}`,
    `ftp://${workspace.host}`,
    `https://user@${workspace.host}`,
    `https://:test-only@${workspace.host}`,
    `${workspace.origin}/v1?private=value`,
    `${workspace.origin}/v1#private`,
  ])('rejects unsafe target %s without including its value in the error', target => {
    expect(() => assertDatabricksTargetsMatchWorkspace({ OPENAI_API_TARGET: target }, workspace))
      .toThrow(new Error('Databricks API target must match the configured HTTPS workspace origin'));
  });

  it('rejects malformed targets with a value-free error', () => {
    expect(() => assertDatabricksTargetsMatchWorkspace({ OPENAI_API_TARGET: 'https://[' }, workspace))
      .toThrow(new Error('Invalid Databricks API target binding'));
  });

  it.each([
    'api.openai.com', 'API.OPENAI.COM.', 'api.anthropic.com', 'githubcopilot.com',
    'api.githubcopilot.com', 'api.enterprise.githubcopilot.com',
    'copilot-api.enterprise.ghe.com', 'COPILOT-API.ENTERPRISE.GHE.COM.',
  ])('rejects known provider hostname %s even when its origin matches', hostname => {
    const origin = new URL(`https://${hostname}`);
    expect(() => assertDatabricksTargetsMatchWorkspace({ OPENAI_API_TARGET: origin.href }, origin))
      .toThrow('Databricks API target must match the configured HTTPS workspace origin');
  });
});
