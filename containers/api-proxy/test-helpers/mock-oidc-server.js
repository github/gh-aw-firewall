'use strict';

const http = require('http');

function createBaseMockServer(handleProviderRoute, handlers = {}) {
  const routeHandler = handleProviderRoute || (() => false);

  return http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/token' && req.method === 'GET') {
        const handler = handlers.oidcToken || (() => ({
          statusCode: 200,
          body: JSON.stringify({ value: 'mock-github-oidc-jwt', count: 1 }),
        }));
        const result = handler(url, req);
        res.writeHead(result.statusCode, { 'Content-Type': 'application/json' });
        res.end(result.body);
        return;
      }

      const handled = routeHandler(url, req, res, handlers, body);
      if (handled) {
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });
  });
}

module.exports = { createBaseMockServer };
