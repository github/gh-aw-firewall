'use strict';
/**
 * TCP tunnel for TLS hostname matching.
 *
 * The external DIFC proxy's self-signed TLS cert has SANs for localhost
 * and 127.0.0.1, but not host.docker.internal.  This tunnel forwards
 * localhost:localPort → remoteHost:remotePort so that the gh CLI can
 * connect to localhost (matching the cert's SAN) while the actual
 * traffic goes to the external DIFC proxy on the host.
 *
 * Usage: node tcp-tunnel.js <localPort> <remoteHost> <remotePort>
 */

const net = require('net');

const [localPort, remoteHost, remotePort] = [process.argv[2], process.argv[3], process.argv[4]];

if (!localPort || !remoteHost || !remotePort) {
  console.error('[tcp-tunnel] Usage: node tcp-tunnel.js <localPort> <remoteHost> <remotePort>');
  process.exit(1);
}

net.createServer(client => {
  const upstream = net.connect(+remotePort, remoteHost);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}).listen(+localPort, '127.0.0.1', () => {
  console.log(`[tcp-tunnel] Forwarding localhost:${localPort} → ${remoteHost}:${remotePort}`);
});
