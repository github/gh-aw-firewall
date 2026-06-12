/**
 * Comprehensive auth matrix tests.
 *
 * Tests every documented combination of (engine × auth-type × instance-type)
 * to ensure the correct HTTP headers are sent upstream. See docs/auth-matrix.md
 * for the full specification.
 *
 * Addresses coverage gaps identified in GitHub issue #4793.
 */

'use strict';

const { createOpenAIAdapter } = require('./providers/openai');
const { createAnthropicAdapter } = require('./providers/anthropic');
const { createCopilotAdapter } = require('./providers/copilot');
const { createGeminiAdapter } = require('./providers/gemini');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const fakeReq = (url = '/v1/chat/completions', method = 'POST') => ({
  url,
  method,
  headers: {},
});

const modelsReq = () => fakeReq('/models', 'GET');

function injectOidcToken(adapter, token = 'oidc-access-token', ttl = 600) {
  const provider = adapter.getOidcProvider();
  if (!provider) return null;
  provider._cachedToken = token;
  provider._expiresAt = Math.floor(Date.now() / 1000) + ttl;
  return provider;
}

// ---------------------------------------------------------------------------
// OpenAI Auth Matrix
// ---------------------------------------------------------------------------

describe('Auth Matrix — OpenAI', () => {
  describe('static API key', () => {
    it('sends Authorization: Bearer with OpenAI key', () => {
      const adapter = createOpenAIAdapter({ OPENAI_API_KEY: 'sk-test-key' });
      expect(adapter.getAuthHeaders(fakeReq())).toEqual({
        Authorization: 'Bearer sk-test-key',
      });
    });

    it('targets api.openai.com by default', () => {
      const adapter = createOpenAIAdapter({ OPENAI_API_KEY: 'sk-test' });
      const probe = adapter.getValidationProbe();
      expect(probe.url).toContain('api.openai.com');
    });

    it('respects OPENAI_API_TARGET override', () => {
      const adapter = createOpenAIAdapter({
        OPENAI_API_KEY: 'sk-test',
        OPENAI_API_TARGET: 'https://my-gateway.example.com',
      });
      expect(adapter.getTargetHost()).toBe('my-gateway.example.com');
    });
  });

  describe('Azure BYOK (COPILOT_PROVIDER_TYPE=azure)', () => {
    it('uses api-key header (not Authorization) for Azure BYOK', () => {
      const adapter = createOpenAIAdapter({
        COPILOT_PROVIDER_TYPE: 'azure',
        COPILOT_PROVIDER_API_KEY: 'azure-key-123',
        COPILOT_PROVIDER_BASE_URL: 'https://my-resource.openai.azure.com/openai',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['api-key']).toBe('azure-key-123');
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe('Azure OIDC (Entra ID)', () => {
    let adapter, provider;

    beforeEach(() => {
      adapter = createOpenAIAdapter({
        OPENAI_API_KEY: 'sk-placeholder',
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant-123',
        AWF_AUTH_AZURE_CLIENT_ID: 'client-456',
      });
      provider = injectOidcToken(adapter, 'entra-access-token');
    });

    afterEach(() => { provider?.shutdown(); });

    it('sends Authorization: Bearer with Entra token (not api-key)', () => {
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer entra-access-token');
      expect(headers['api-key']).toBeUndefined();
    });

    it('returns empty headers when OIDC token not yet available', () => {
      const fresh = createOpenAIAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant-123',
        AWF_AUTH_AZURE_CLIENT_ID: 'client-456',
      });
      expect(fresh.getAuthHeaders(fakeReq())).toEqual({});
      fresh.getOidcProvider().shutdown();
    });
  });

  describe('Azure BYOK + OIDC interaction', () => {
    it('OIDC overrides api-key header with Bearer when token available', () => {
      const adapter = createOpenAIAdapter({
        COPILOT_PROVIDER_TYPE: 'azure',
        COPILOT_PROVIDER_API_KEY: 'azure-key-static',
        COPILOT_PROVIDER_BASE_URL: 'https://my-resource.openai.azure.com/openai',
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant-123',
        AWF_AUTH_AZURE_CLIENT_ID: 'client-456',
      });
      const provider = injectOidcToken(adapter, 'entra-oidc-token');
      const headers = adapter.getAuthHeaders(fakeReq());
      // When OIDC is active, Bearer replaces api-key
      expect(headers.Authorization).toBe('Bearer entra-oidc-token');
      expect(headers['api-key']).toBeUndefined();
      provider.shutdown();
    });
  });

  describe('custom auth header (AWF_OPENAI_AUTH_HEADER)', () => {
    it('replaces Authorization with custom header name', () => {
      const adapter = createOpenAIAdapter({
        OPENAI_API_KEY: 'sk-test',
        AWF_OPENAI_AUTH_HEADER: 'x-custom-auth',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['x-custom-auth']).toBe('sk-test');
      expect(headers.Authorization).toBeUndefined();
    });

    it('custom header is used with OIDC token too', () => {
      const adapter = createOpenAIAdapter({
        OPENAI_API_KEY: 'sk-test',
        AWF_OPENAI_AUTH_HEADER: 'x-custom-auth',
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant',
        AWF_AUTH_AZURE_CLIENT_ID: 'client',
      });
      const provider = injectOidcToken(adapter, 'oidc-tok');
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['x-custom-auth']).toBe('oidc-tok');
      expect(headers.Authorization).toBeUndefined();
      provider.shutdown();
    });
  });
});

// ---------------------------------------------------------------------------
// Anthropic Auth Matrix
// ---------------------------------------------------------------------------

describe('Auth Matrix — Anthropic', () => {
  describe('static API key', () => {
    it('sends x-api-key header with API key', () => {
      const adapter = createAnthropicAdapter({ ANTHROPIC_API_KEY: 'sk-ant-test' });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['x-api-key']).toBe('sk-ant-test');
      expect(headers.Authorization).toBeUndefined();
    });

    it('targets api.anthropic.com by default', () => {
      const adapter = createAnthropicAdapter({ ANTHROPIC_API_KEY: 'sk-ant-test' });
      const probe = adapter.getValidationProbe();
      expect(probe.url).toContain('api.anthropic.com');
    });
  });

  describe('Workload Identity Federation (WIF)', () => {
    it('switches from x-api-key to Authorization: Bearer when OIDC token available', () => {
      const adapter = createAnthropicAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'anthropic',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
        AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid',
        AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
      });
      const provider = adapter.getOidcProvider();
      provider._cachedToken = 'sk-ant-oat01-wif-token';
      provider._expiresAt = Math.floor(Date.now() / 1000) + 600;

      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer sk-ant-oat01-wif-token');
      expect(headers['x-api-key']).toBeUndefined();
      provider.shutdown();
    });

    it('returns empty headers when WIF token not yet available', () => {
      const adapter = createAnthropicAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'anthropic',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
        AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid',
        AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
      });
      expect(adapter.getAuthHeaders(fakeReq())).toEqual({});
      adapter.getOidcProvider().shutdown();
    });

    it('reports unavailable status in health response before token ready', () => {
      const adapter = createAnthropicAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'anthropic',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
        AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid',
        AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
      });
      const resp = adapter.getUnconfiguredHealthResponse();
      expect(resp.statusCode).toBe(503);
      expect(resp.body.status).toBe('unavailable');
      adapter.getOidcProvider().shutdown();
    });
  });

  describe('custom auth header (AWF_ANTHROPIC_AUTH_HEADER)', () => {
    it('replaces x-api-key with custom header name', () => {
      const adapter = createAnthropicAdapter({
        ANTHROPIC_API_KEY: 'sk-ant-test',
        AWF_ANTHROPIC_AUTH_HEADER: 'x-custom-key',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['x-custom-key']).toBe('sk-ant-test');
      expect(headers['x-api-key']).toBeUndefined();
    });

    it('throws on invalid header name', () => {
      expect(() => createAnthropicAdapter({
        ANTHROPIC_API_KEY: 'sk-ant-test',
        AWF_ANTHROPIC_AUTH_HEADER: 'invalid header!',
      })).toThrow(/Invalid AWF_ANTHROPIC_AUTH_HEADER/);
    });
  });
});

// ---------------------------------------------------------------------------
// Copilot Auth Matrix
// ---------------------------------------------------------------------------

describe('Auth Matrix — Copilot', () => {
  describe('GitHub OAuth token — github.com', () => {
    it('sends Authorization: Bearer with GitHub token', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_test123',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer ghu_test123');
      expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
    });
  });

  describe('GitHub OAuth token — GHEC (*.ghe.com)', () => {
    it('sends Authorization: Bearer (not token) for GHEC', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_ghec_token',
        GITHUB_SERVER_URL: 'https://mycompany.ghe.com',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer ghu_ghec_token');
    });

    it('derives correct copilot-api target for GHEC', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_test',
        GITHUB_SERVER_URL: 'https://mycompany.ghe.com',
      });
      expect(adapter.getTargetHost()).toBe('copilot-api.mycompany.ghe.com');
    });
  });

  describe('GitHub OAuth token — GHES (on-prem)', () => {
    it('sends Authorization: token (NOT Bearer) for GHES enterprise endpoint', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_ghes_token',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('token ghu_ghes_token');
    });

    it('targets api.enterprise.githubcopilot.com for GHES', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_test',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      expect(adapter.getTargetHost()).toBe('api.enterprise.githubcopilot.com');
    });

    it('/models endpoint also uses token prefix on GHES', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_ghes_token',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      const headers = adapter.getAuthHeaders(modelsReq());
      expect(headers.Authorization).toBe('token ghu_ghes_token');
    });
  });

  describe('GHES + BYOK interaction', () => {
    it('BYOK key uses Bearer even on GHES enterprise endpoint', () => {
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      // BYOK always uses Bearer, even when target is api.enterprise.githubcopilot.com
      expect(headers.Authorization).toBe('Bearer sk-byok-key');
    });

    it('/models falls back to GitHub token with token prefix on GHES even in BYOK mode', () => {
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'sk-byok-key',
        COPILOT_GITHUB_TOKEN: 'ghu_ghes_token',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      const headers = adapter.getAuthHeaders(modelsReq());
      // /models always uses GitHub OAuth token
      expect(headers.Authorization).toBe('token ghu_ghes_token');
    });
  });

  describe('BYOK mode (standard)', () => {
    it('sends Authorization: Bearer with BYOK key', () => {
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc',
      });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer sk-or-v1-abc');
    });

    it('/models uses BYOK key when no GitHub token available', () => {
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc',
      });
      const headers = adapter.getAuthHeaders(modelsReq());
      expect(headers.Authorization).toBe('Bearer sk-or-v1-abc');
    });

    it('/models prefers GitHub token over BYOK key when both present', () => {
      const adapter = createCopilotAdapter({
        COPILOT_PROVIDER_API_KEY: 'sk-or-v1-abc',
        COPILOT_GITHUB_TOKEN: 'ghu_oauth_token',
      });
      const headers = adapter.getAuthHeaders(modelsReq());
      expect(headers.Authorization).toBe('Bearer ghu_oauth_token');
    });
  });

  describe('Azure OIDC (Entra ID) via Copilot', () => {
    let adapter, provider;

    beforeEach(() => {
      adapter = createCopilotAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant-uuid',
        AWF_AUTH_AZURE_CLIENT_ID: 'client-uuid',
        COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
      });
      provider = injectOidcToken(adapter, 'entra-copilot-token');
    });

    afterEach(() => { provider?.shutdown(); });

    it('sends Authorization: Bearer with Entra token', () => {
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer entra-copilot-token');
      expect(headers['Copilot-Integration-Id']).toBe('agentic-workflows');
    });

    it('always uses Bearer prefix (never token) for OIDC', () => {
      // Even if target would normally use 'token' prefix, OIDC always uses Bearer
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toMatch(/^Bearer /);
    });
  });

  describe('GCP OIDC via Copilot', () => {
    it('creates GCP OIDC provider when AWF_AUTH_PROVIDER=gcp', () => {
      const adapter = createCopilotAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'gcp',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/gh',
        COPILOT_PROVIDER_BASE_URL: 'https://us-central1-aiplatform.googleapis.com/v1',
      });
      const provider = adapter.getOidcProvider();
      expect(provider).toBeTruthy();
      provider.shutdown();
    });

    it('injects Bearer token from GCP OIDC provider', () => {
      const adapter = createCopilotAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'gcp',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_GCP_WORKLOAD_IDENTITY_PROVIDER: 'projects/123/locations/global/workloadIdentityPools/pool/providers/gh',
        COPILOT_PROVIDER_BASE_URL: 'https://us-central1-aiplatform.googleapis.com/v1',
      });
      const provider = injectOidcToken(adapter, 'gcp-access-token');
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer gcp-access-token');
      provider.shutdown();
    });
  });

  describe('AWS OIDC via Copilot', () => {
    it('creates AWS OIDC provider when AWF_AUTH_PROVIDER=aws', () => {
      const adapter = createCopilotAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'aws',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AWS_ROLE_ARN: 'arn:aws:iam::123456:role/test',
        AWF_AUTH_AWS_REGION: 'us-east-1',
        COPILOT_PROVIDER_BASE_URL: 'https://bedrock-runtime.us-east-1.amazonaws.com',
      });
      const awsProvider = adapter.getAwsOidcProvider();
      expect(awsProvider).toBeTruthy();
      // AWS uses SigV4 — no static auth header returned
      expect(adapter.getAuthHeaders(fakeReq())).toEqual({});
      awsProvider.shutdown();
    });
  });

  describe('static BYOK key takes precedence over OIDC', () => {
    it('ignores OIDC when COPILOT_PROVIDER_API_KEY is set', () => {
      const adapter = createCopilotAdapter({
        AWF_AUTH_TYPE: 'github-oidc',
        AWF_AUTH_PROVIDER: 'azure',
        ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'runtime-token',
        AWF_AUTH_AZURE_TENANT_ID: 'tenant',
        AWF_AUTH_AZURE_CLIENT_ID: 'client',
        COPILOT_PROVIDER_API_KEY: 'sk-static-byok',
      });
      expect(adapter.getOidcProvider()).toBeNull();
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers.Authorization).toBe('Bearer sk-static-byok');
    });
  });

  describe('COPILOT_API_TARGET override', () => {
    it('explicit COPILOT_API_TARGET overrides GITHUB_SERVER_URL derivation', () => {
      const adapter = createCopilotAdapter({
        COPILOT_GITHUB_TOKEN: 'ghu_test',
        COPILOT_API_TARGET: 'https://custom-copilot.internal.example.com',
        GITHUB_SERVER_URL: 'https://ghes.example.com',
      });
      expect(adapter.getTargetHost()).toBe('custom-copilot.internal.example.com');
    });
  });
});

// ---------------------------------------------------------------------------
// Gemini Auth Matrix
// ---------------------------------------------------------------------------

describe('Auth Matrix — Gemini', () => {
  describe('static API key', () => {
    it('sends x-goog-api-key header', () => {
      const adapter = createGeminiAdapter({ GEMINI_API_KEY: 'AIza-test-key' });
      const headers = adapter.getAuthHeaders(fakeReq());
      expect(headers['x-goog-api-key']).toBe('AIza-test-key');
      expect(headers.Authorization).toBeUndefined();
    });

    it('targets generativelanguage.googleapis.com by default', () => {
      const adapter = createGeminiAdapter({ GEMINI_API_KEY: 'AIza-test' });
      const probe = adapter.getValidationProbe();
      expect(probe.url).toContain('generativelanguage.googleapis.com');
    });

    it('respects GEMINI_API_TARGET override', () => {
      const adapter = createGeminiAdapter({
        GEMINI_API_KEY: 'AIza-test',
        GEMINI_API_TARGET: 'https://custom-gemini.example.com',
      });
      expect(adapter.getTargetHost()).toBe('custom-gemini.example.com');
    });
  });

  describe('isEnabled gating', () => {
    it('is disabled when no API key set', () => {
      const adapter = createGeminiAdapter({});
      expect(adapter.isEnabled()).toBe(false);
    });

    it('is enabled when API key is set', () => {
      const adapter = createGeminiAdapter({ GEMINI_API_KEY: 'AIza-test' });
      expect(adapter.isEnabled()).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: credential isolation
// ---------------------------------------------------------------------------

describe('Auth Matrix — Credential Isolation', () => {
  it('Copilot placeholder token (ghu_aaa...) is recognized as BYOK mode', () => {
    // The placeholder ensures Copilot CLI auth preflight passes without real creds
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      COPILOT_PROVIDER_API_KEY: 'sk-real-byok-key',
    });
    const headers = adapter.getAuthHeaders(fakeReq());
    // Inference uses BYOK key, not the placeholder
    expect(headers.Authorization).toBe('Bearer sk-real-byok-key');
  });

  it('Copilot dummy BYOK key is used as-is at the adapter level', () => {
    // The 'dummy-byok-key-for-offline-mode' string has no special handling
    // in the adapter — it's treated as a regular BYOK key. The Copilot CLI
    // auth layer (copilot-auth.js) is where placeholder detection occurs.
    const adapter = createCopilotAdapter({
      COPILOT_GITHUB_TOKEN: 'ghu_real_token',
      COPILOT_PROVIDER_API_KEY: 'dummy-byok-key-for-offline-mode',
    });
    const headers = adapter.getAuthHeaders(fakeReq());
    // BYOK key is present so it's used for inference
    expect(headers.Authorization).toBe('Bearer dummy-byok-key-for-offline-mode');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: isEnabled behavior with OIDC
// ---------------------------------------------------------------------------

describe('Auth Matrix — isEnabled with OIDC', () => {
  it('OpenAI isEnabled=false before OIDC token acquired', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'client',
    });
    expect(adapter.isEnabled()).toBe(false);
    adapter.getOidcProvider().shutdown();
  });

  it('OpenAI isEnabled=true after OIDC token acquired', () => {
    const adapter = createOpenAIAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'client',
    });
    const provider = injectOidcToken(adapter);
    expect(adapter.isEnabled()).toBe(true);
    provider.shutdown();
  });

  it('Anthropic isEnabled=false before WIF token acquired', () => {
    const adapter = createAnthropicAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'anthropic',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
      AWF_AUTH_ANTHROPIC_FEDERATION_RULE_ID: 'fdrl_test',
      AWF_AUTH_ANTHROPIC_ORGANIZATION_ID: 'org-uuid',
      AWF_AUTH_ANTHROPIC_SERVICE_ACCOUNT_ID: 'svac_test',
    });
    expect(adapter.isEnabled()).toBe(false);
    adapter.getOidcProvider().shutdown();
  });

  it('Copilot isEnabled=false before Azure OIDC token acquired', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'client',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });
    expect(adapter.isEnabled()).toBe(false);
    adapter.getOidcProvider().shutdown();
  });

  it('Copilot isEnabled=true after Azure OIDC token acquired', () => {
    const adapter = createCopilotAdapter({
      AWF_AUTH_TYPE: 'github-oidc',
      AWF_AUTH_PROVIDER: 'azure',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'http://localhost/token',
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'test',
      AWF_AUTH_AZURE_TENANT_ID: 'tenant',
      AWF_AUTH_AZURE_CLIENT_ID: 'client',
      COPILOT_PROVIDER_BASE_URL: 'https://aoai.example.com/openai',
    });
    const provider = injectOidcToken(adapter, 'entra-token');
    expect(adapter.isEnabled()).toBe(true);
    provider.shutdown();
  });
});
