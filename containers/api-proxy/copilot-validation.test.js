const { buildCopilotModelsRequest, getCopilotValidationProbe } = require('./providers/copilot-validation');
const { createCopilotAdapter } = require('./providers/copilot');

const context = {
  rawTarget: 'api.enterprise.githubcopilot.com',
  githubTokenAuthPrefix: 'token',
  githubToken: 'github-test',
  authToken: 'byok-test',
  integrationId: 'test-integration',
};

describe('getCopilotValidationProbe', () => {
  it.each([
    [{ oidcConfigured: true, authProvider: 'azure', authToken: undefined }, { skip: true, reason: 'OIDC auth (azure); validation via token acquisition' }],
    [{ oidcConfigured: true, authProvider: 'databricks', databricksSelected: true }, { skip: true, reason: 'OIDC auth (databricks); validation via token acquisition' }],
    [{ databricksSelected: true }, null],
    [{ authToken: undefined }, null],
    [{ githubToken: undefined }, { skip: true, reason: 'COPILOT_PROVIDER_API_KEY configured but startup validation is not supported for this auth mode' }],
    [{ rawTarget: 'byok.example.com' }, { skip: true, reason: 'Custom target byok.example.com; validation skipped' }],
  ])('preserves startup validation decision for %j', (overrides, expected) => {
    expect(getCopilotValidationProbe({ ...context, ...overrides })).toEqual(expected);
  });

  it('uses the GitHub token rather than the BYOK key for the probe', () => {
    expect(getCopilotValidationProbe(context)).toEqual({
      url: 'https://api.enterprise.githubcopilot.com/models',
      opts: {
        method: 'GET',
        headers: {
          Authorization: 'token github-test',
          'X-GitHub-Api-Version': '2026-07-01',
          'Copilot-Integration-Id': 'test-integration',
        },
      },
      modelMetadataFormat: 'copilot',
      apiVersion: '2026-07-01',
    });
  });

  it('keeps validation and model-fetch headers aligned through adapter assembly', () => {
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: context.githubToken,
      COPILOT_PROVIDER_API_KEY: context.authToken,
      COPILOT_API_TARGET: context.rawTarget,
      COPILOT_API_BASE_PATH: '/api/v1',
      COPILOT_INTEGRATION_ID: context.integrationId,
    });
    expect(adapter.getValidationProbe()).toEqual(buildCopilotModelsRequest(context));
    expect(adapter.getModelsFetchConfig()).toEqual({
      ...adapter.getValidationProbe(), cacheKey: 'copilot',
    });
  });
});

describe('buildCopilotModelsRequest', () => {
  it.each([
    ['api.githubcopilot.com', 'https://api.githubcopilot.com/models'],
    ['http://localhost:8080', 'http://localhost:8080/models'],
  ])('preserves scheme and port for %s', (rawTarget, url) => {
    const request = buildCopilotModelsRequest({ ...context, rawTarget }, { cacheKey: 'copilot' });
    expect(request.url).toBe(url);
    expect(request.cacheKey).toBe('copilot');
  });
});
