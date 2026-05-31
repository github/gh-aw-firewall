'use strict';

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

module.exports = { withMockServer };
