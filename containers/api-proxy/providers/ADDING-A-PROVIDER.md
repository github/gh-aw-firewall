# Adding a New LLM Provider to the AWF API Proxy

This guide explains how to wire a new LLM provider into the AWF API proxy in three steps:

1. Create an adapter file in this directory (`providers/<name>.js`)
2. Register it in `providers/index.js`
3. Update the Dockerfile COPY list

The core proxy engine (`server.js`) is completely agnostic of provider details — it only calls the methods defined on the `ProviderAdapter` interface. You never need to touch the core to add a new provider.

---

## Step 1 — Create the adapter file

Create `providers/<name>.js`. The adapter is a plain JS object (no class syntax required) returned by a factory function:

```js
'use strict';

const { normalizeApiTarget, normalizeBasePath } = require('../proxy-utils');

function createMyProviderAdapter(env, deps = {}) {
  // Read credentials and config from env at construction time
  const apiKey   = (env.MY_PROVIDER_API_KEY || '').trim() || undefined;
  const target   = normalizeApiTarget(env.MY_PROVIDER_API_TARGET) || 'api.myprovider.com';
  const basePath = normalizeBasePath(env.MY_PROVIDER_API_BASE_PATH);

  const bodyTransform = deps.bodyTransform || null;   // model-alias rewriting etc.

  return {
    // ── Identity ─────────────────────────────────────────────────────────────
    name: 'my-provider',   // unique lowercase slug
    port: 10005,           // next available port (update Dockerfile EXPOSE too)

    isManagementPort: false,   // true only for port 10000 (OpenAI)
    alwaysBind: false,         // set true to start a 503-stub when not configured
    get participatesInValidation() { return this.isEnabled(); },

    // ── Credentials ──────────────────────────────────────────────────────────
    isEnabled()       { return !!apiKey; },
    getTargetHost()   { return target; },
    getBasePath()     { return basePath; },

    // ── Per-request auth headers ──────────────────────────────────────────────
    // `req` is the incoming http.IncomingMessage — inspect it for request-specific logic.
    getAuthHeaders(req) {
      return { 'Authorization': `Bearer ${apiKey}` };
    },

    // ── Optional: URL transform ───────────────────────────────────────────────
    // Return the (possibly modified) URL string, or omit this method entirely.
    transformRequestUrl(url) { return url; },

    // ── Optional: body transform ──────────────────────────────────────────────
    // Return a function (body: Buffer) => Buffer|null, or null for no transform.
    getBodyTransform() { return bodyTransform; },

    // ── Startup: credential validation ───────────────────────────────────────
    // Return a probe config, a skip config, or null if validation is not applicable.
    getValidationProbe() {
      if (!apiKey) return null;
      if (target !== 'api.myprovider.com') {
        return { skip: true, reason: `Custom target ${target}; validation skipped` };
      }
      return {
        url: `https://${target}/v1/models`,
        opts: { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
      };
    },

    // ── Startup: model listing ────────────────────────────────────────────────
    // Return null to opt out of model fetching.
    getModelsFetchConfig() {
      if (!apiKey) return null;
      return {
        url:      `https://${target}/v1/models`,
        opts:     { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` } },
        cacheKey: 'my-provider',   // key in cachedModels; must match name
      };
    },

    // ── /reflect endpoint metadata ────────────────────────────────────────────
    getReflectionInfo() {
      return {
        provider:        'my-provider',
        port:            10005,
        base_url:        'http://api-proxy:10005',
        configured:      !!apiKey,
        models_cache_key: 'my-provider',   // null when models are not fetched
        models_url:       'http://api-proxy:10005/v1/models',
      };
    },
  };
}

module.exports = { createMyProviderAdapter };
```

### Provider adapter reference

| Method / property | Required? | Description |
|---|---|---|
| `name` | ✅ | Unique lowercase slug (matches cache key and log labels) |
| `port` | ✅ | Port to listen on; must be unique across all adapters |
| `isManagementPort` | ✅ | `true` only for the one port that serves `/health`, `/metrics`, `/reflect` |
| `alwaysBind` | ✅ | `true` to start a stub server even when `isEnabled()` returns false |
| `participatesInValidation` | ✅ | `true` when this adapter should count in the startup latch |
| `isEnabled()` | ✅ | Returns `true` when credentials are present |
| `getTargetHost(req?)` | ✅ | Returns the upstream hostname |
| `getBasePath(req?)` | ✅ | Returns the URL path prefix (empty string for none) |
| `getAuthHeaders(req)` | ✅ | Returns headers to inject (auth, version, integration ID, …) |
| `transformRequestUrl(url)` | ➖ optional | Mutate the request URL before forwarding (e.g. strip query params) |
| `getBodyTransform()` | ✅ | Returns `(Buffer) => Buffer\|null` or `null` |
| `getValidationProbe()` | ✅ | Returns probe config, `{ skip, reason }`, or `null` |
| `getModelsFetchConfig()` | ✅ | Returns fetch config or `null` |
| `getReflectionInfo()` | ✅ | Returns endpoint metadata for `/reflect` and `models.json` |
| `getUnconfiguredResponse()` | ➖ optional | Response for proxy requests when `alwaysBind=true` & not enabled |
| `getUnconfiguredHealthResponse()` | ➖ optional | `/health` response when not enabled (defaults to 503) |

---

## Step 2 — Register in `providers/index.js`

```js
// 1. Import your factory
const { createMyProviderAdapter } = require('./my-provider');

// 2. Construct the adapter alongside the others in createAllAdapters():
function createAllAdapters(env, deps = {}) {
  const openai    = createOpenAIAdapter(env,    { bodyTransform: deps.openaiBodyTransform    });
  const anthropic = createAnthropicAdapter(env, { bodyTransform: deps.anthropicBodyTransform });
  const copilot   = createCopilotAdapter(env,   { bodyTransform: deps.copilotBodyTransform   });
  const gemini    = createGeminiAdapter(env,    { bodyTransform: deps.geminiBodyTransform    });
  const myProvider = createMyProviderAdapter(env, { bodyTransform: deps.myProviderBodyTransform }); // ← add here

  // OpenCode routes to the first enabled candidate in priority order.
  // Add myProvider to this list if you want OpenCode to route through it.
  const opencode  = createOpenCodeAdapter(env, { candidateAdapters: [openai, anthropic, copilot] });

  return [openai, anthropic, copilot, gemini, opencode, myProvider]; // ← include in return
}

// 3. Export it alongside the others
module.exports = {
  createAllAdapters,
  // ...existing exports...
  createMyProviderAdapter,
};
```

If your provider needs model-alias rewriting, also add a corresponding
`myProviderBodyTransform` in server.js (mirroring how the existing transforms
are built and passed into `createAllAdapters`).

### Optional: add your provider to OpenCode's routing

OpenCode (port 10004) automatically routes to the first enabled adapter in its
`candidateAdapters` list.  If you want OpenCode to fall back to your provider,
add it to that list in the desired priority position — **no changes to
`opencode.js` are needed**:

```js
// In createAllAdapters(), update the opencode line:
const opencode = createOpenCodeAdapter(env, {
  candidateAdapters: [openai, anthropic, copilot, myProvider], // ← add at desired priority position
});
```

All providers remain independently reachable on their own ports regardless of
whether they appear in the OpenCode candidate list.

---

## Step 3 — Update the Dockerfile

Add the new adapter file to the explicit `COPY` list in `containers/api-proxy/Dockerfile`:

```dockerfile
COPY server.js logging.js metrics.js rate-limiter.js token-tracker.js \
     model-resolver.js proxy-utils.js anthropic-cache.js anthropic-transforms.js \
     providers/ ./
```

Also update the `EXPOSE` directive to include the new port:

```dockerfile
EXPOSE 10000 10001 10002 10003 10004 10005
```

---

## Checklist

- [ ] `providers/<name>.js` created and exports `create<Name>Adapter`
- [ ] Adapter registered in `providers/index.js` (`createAllAdapters` + exports)
- [ ] `Dockerfile` updated: `providers/` in COPY list, port in EXPOSE
- [ ] Add provider env vars to `src/docker-manager.ts` if they need forwarding from the host
- [ ] Add domain to `docs/allowed-domains.md` or equivalent if the upstream is new
- [ ] Write adapter unit tests in `providers/<name>.test.js`
- [ ] (Optional) Add adapter to OpenCode's `candidateAdapters` list in `providers/index.js` if OpenCode should route through it

---

## Testing your adapter in isolation

Because each adapter is a plain object, you can unit-test it without starting any HTTP servers:

```js
const { createMyProviderAdapter } = require('./my-provider');

describe('MyProvider adapter', () => {
  it('returns correct auth headers', () => {
    const adapter = createMyProviderAdapter({ MY_PROVIDER_API_KEY: 'test-key' });
    const fakeReq = { headers: {}, method: 'POST', url: '/v1/chat' };
    expect(adapter.getAuthHeaders(fakeReq)).toEqual({ Authorization: 'Bearer test-key' });
  });

  it('reports not configured when key is absent', () => {
    const adapter = createMyProviderAdapter({});
    expect(adapter.isEnabled()).toBe(false);
  });
});
```
