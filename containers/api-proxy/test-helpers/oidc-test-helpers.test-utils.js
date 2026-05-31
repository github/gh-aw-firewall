'use strict';

function withMockServer(createMockServer) {
  let mockServer;
  let serverPort;

  beforeAll((done) => {
    mockServer = createMockServer();
    mockServer.listen(0, '127.0.0.1', () => {
      serverPort = mockServer.address().port;
      done();
    });
  });

  afterAll((done) => {
    mockServer.close(done);
  });

  return {
    getServerPort: () => serverPort,
  };
}

module.exports = { withMockServer };
