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

function sanitizeForLog(value) {
  return String(value).replace(/[\r\n]/g, '');
}

const localPortStr = process.argv[2];
const remoteHost = process.argv[3];
const remotePortStr = process.argv[4];

if (!localPortStr || !remoteHost || !remotePortStr) {
  console.error('[tcp-tunnel] Usage: node tcp-tunnel.js <localPort> <remoteHost> <remotePort>');
  process.exit(1);
}

const localPort = parseInt(localPortStr, 10);
const remotePort = parseInt(remotePortStr, 10);

if (isNaN(localPort) || localPort < 1 || localPort > 65535) {
  console.error(`[tcp-tunnel] Invalid localPort: ${localPortStr}`);
  process.exit(1);
}
if (isNaN(remotePort) || remotePort < 1 || remotePort > 65535) {
  console.error(`[tcp-tunnel] Invalid remotePort: ${remotePortStr}`);
  process.exit(1);
}

const bindHosts = ['127.0.0.1', '::1'];
let startedServers = 0;
let readyLogged = false;

function handleConnection(client) {
  const clientAddr = `${client.remoteAddress}:${client.remotePort}`;
  console.error(`[tcp-tunnel] Connection from ${sanitizeForLog(clientAddr)}`);
  const upstream = net.connect(remotePort, remoteHost);
  client.pipe(upstream);
  upstream.pipe(client);
  client.on('error', (err) => { console.error(`[tcp-tunnel] Client error (${sanitizeForLog(clientAddr)}): ${sanitizeForLog(err.message)}`); upstream.destroy(); });
  upstream.on('error', (err) => { console.error(`[tcp-tunnel] Upstream error (${sanitizeForLog(clientAddr)}): ${sanitizeForLog(err.message)}`); client.destroy(); });
  client.on('close', () => { console.error(`[tcp-tunnel] Connection closed: ${sanitizeForLog(clientAddr)}`); });
}

for (const bindHost of bindHosts) {
  const server = net.createServer(handleConnection);
  server.on('error', (err) => {
    const errCode = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if ((errCode === 'EADDRNOTAVAIL' || errCode === 'EAFNOSUPPORT') && bindHost === '::1') {
      console.error(`[tcp-tunnel] IPv6 loopback unavailable, skipping ::1 bind (${sanitizeForLog(err.message)})`);
      return;
    }
    console.error(`[tcp-tunnel] Server error (${bindHost}):`, sanitizeForLog(err.message));
    process.exit(1);
  });

  server.listen(localPort, bindHost, () => {
    startedServers += 1;
    if (!readyLogged && (startedServers === bindHosts.length || bindHost === '127.0.0.1')) {
      readyLogged = true;
      console.log(`[tcp-tunnel] Forwarding localhost:${localPort} → ${remoteHost}:${remotePort}`);
    }
  });
}
