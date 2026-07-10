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
  const startedServers = [];
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
    startedServers.push(server);
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

  let shuttingDown = false;
  async function shutdownGracefully(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logRequest('info', 'shutdown', { message: `Received ${signal}, shutting down gracefully` });
    const forceExitMs = Number.parseInt(process.env.AWF_API_PROXY_SHUTDOWN_TIMEOUT_MS || '8000', 10);
    const forceExitTimer = setTimeout(() => {
      logRequest('warn', 'shutdown_force_exit', {
        message: `Forced process exit after ${forceExitMs}ms shutdown timeout`,
      });
      process.exit(0);
    }, Number.isFinite(forceExitMs) && forceExitMs > 0 ? forceExitMs : 8000);
    forceExitTimer.unref();
    await Promise.all(startedServers.map((server) => {
      if (typeof server.shutdownConnections === 'function') {
        return server.shutdownConnections();
      }
      return Promise.resolve();
    }));
    await Promise.all(startedServers.map((server) => new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    })));
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
    clearTimeout(forceExitTimer);
    process.exit(0);
  }

  process.on('SIGTERM', async () => shutdownGracefully('SIGTERM'));
  process.on('SIGINT', async () => shutdownGracefully('SIGINT'));
}

module.exports = {
  bootPrimary,
};
