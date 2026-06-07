'use strict';

const http = require('http');

function withMockServer(createMockServer) {
  let mockServer;
  let serverPort;

  beforeAll((done) => {
    let server;
    try {
      server = createMockServer();
    } catch (err) {
      done(err);
      return;
    }
    server.once('error', (err) => {
      done(err);
    });
    server.listen(0, '127.0.0.1', () => {
      mockServer = server;
      serverPort = mockServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    if (!mockServer) {
      done();
      return;
    }
    mockServer.close(done);
  });

  return {
    getServerPort: () => serverPort,
  };
}

async function testInitializationFailure(ProviderClass, config, options = {}) {
  const failServer = http.createServer((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
  });

  await new Promise((resolve, reject) => {
    const onError = err => {
      failServer.off('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      failServer.off('error', onError);
      resolve();
    };
    failServer.once('error', onError);
    failServer.once('listening', onListening);
    failServer.listen(0, '127.0.0.1');
  });
  const failPort = failServer.address().port;
  const getCachedValue = options.getCachedValue || (provider => provider.getToken());
  let provider;

  try {
    provider = new ProviderClass({
      requestUrl: `http://127.0.0.1:${failPort}/token`,
      requestToken: 'bad-token',
      retryDelayMs: 10,
      maxInitRetries: 2,
      ...config,
    });

    await provider.initialize();

    expect(provider.isReady()).toBe(false);
    expect(getCachedValue(provider)).toBeNull();
  } finally {
    provider?.shutdown();
    await new Promise(resolve => failServer.close(resolve));
  }
}

module.exports = { withMockServer, testInitializationFailure };
