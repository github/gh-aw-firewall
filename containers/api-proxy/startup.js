'use strict';

function bootPrimary({
  registeredAdapters,
  createProviderServer,
  validateApiKeys,
  fetchStartupModels,
  writeModelsJson,
  validateRequestedModel,
  setKeyValidationComplete,
  setModelFetchComplete,
  closeLogStream,
  otelShutdown,
  logRequest,
  HTTPS_PROXY,
}) {
  logRequest('info', 'startup', {
    message: 'Starting AWF API proxy sidecar',
    squid_proxy: HTTPS_PROXY || 'not configured',
    providers_configured: registeredAdapters.filter(a => a.isEnabled()).map(a => a.name),
  });

  const oidcInitPromises = [];
  for (const adapter of registeredAdapters) {
    if (typeof adapter.getOidcProvider === 'function') {
      const provider = adapter.getOidcProvider();
      if (provider) {
        logRequest('info', 'oidc_startup', {
          message: `Initializing OIDC token provider for ${adapter.name}`,
        });
        oidcInitPromises.push(
          provider.initialize().catch((err) => {
            logRequest('error', 'oidc_startup_failed', {
              adapter: adapter.name,
              error: String(err),
            });
          })
        );
      }
    }
    if (typeof adapter.getAwsOidcProvider === 'function') {
      const awsProvider = adapter.getAwsOidcProvider();
      if (awsProvider) {
        logRequest('info', 'oidc_startup', {
          message: `Initializing AWS OIDC credential provider for ${adapter.name}`,
        });
        oidcInitPromises.push(
          awsProvider.initialize().catch((err) => {
            logRequest('error', 'oidc_startup_failed', {
              adapter: adapter.name,
              provider: 'aws',
              error: String(err),
            });
          })
        );
      }
    }
  }

  const adaptersToStart = registeredAdapters.filter(a => a.alwaysBind || a.isEnabled());
  const expectedListeners = adaptersToStart.filter(a => a.participatesInValidation).length;
  let readyListeners = 0;

  function onListenerReady() {
    readyListeners++;
    if (readyListeners === expectedListeners) {
      logRequest('info', 'startup_complete', {
        message: `All ${expectedListeners} validation-participating listeners ready, starting key validation`,
      });

      Promise.all(oidcInitPromises).then(() => {
        validateApiKeys(adaptersToStart).catch((err) => {
          logRequest('error', 'key_validation_error', { message: 'Unexpected error during key validation', error: String(err) });
          setKeyValidationComplete(true);
        });
        fetchStartupModels(adaptersToStart).then(() => {
          writeModelsJson();
          validateRequestedModel();
        }).catch((err) => {
          logRequest('error', 'model_fetch_error', { message: 'Unexpected error fetching startup models', error: String(err) });
          setModelFetchComplete(true);
          writeModelsJson();
        });
      });
    }
  }

  for (const adapter of adaptersToStart) {
    const server = createProviderServer(adapter);
    server.listen(adapter.port, '0.0.0.0', () => {
      logRequest('info', 'server_start', {
        message: `${adapter.name} proxy listening on port ${adapter.port}`,
        target: adapter.isEnabled() ? adapter.getTargetHost() : '(not configured)',
      });
      if (adapter.participatesInValidation) {
        onListenerReady();
      }
    });
  }

  async function shutdownGracefully(signal) {
    logRequest('info', 'shutdown', { message: `Received ${signal}, shutting down gracefully` });
    for (const adapter of registeredAdapters) {
      if (typeof adapter.getOidcProvider === 'function') {
        adapter.getOidcProvider()?.shutdown();
      }
      if (typeof adapter.getAwsOidcProvider === 'function') {
        adapter.getAwsOidcProvider()?.shutdown();
      }
    }
    await closeLogStream();
    await otelShutdown();
    process.exit(0);
  }

  process.on('SIGTERM', async () => shutdownGracefully('SIGTERM'));
  process.on('SIGINT', async () => shutdownGracefully('SIGINT'));
}

module.exports = {
  bootPrimary,
};
