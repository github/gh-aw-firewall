/**
 * Network Security Tests
 *
 * These tests verify security aspects of the firewall:
 * - NET_ADMIN capability is dropped after setup
 * - iptables manipulation is blocked for user commands
 * - Firewall bypass attempts are blocked
 * - SSRF protection
 */

/// <reference path="../jest-custom-matchers.d.ts" />

import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import { createRunner, AwfRunner } from '../fixtures/awf-runner';
import { cleanup } from '../fixtures/cleanup';

describe('Network Security', () => {
  let runner: AwfRunner;

  beforeAll(async () => {
    await cleanup(false);
    runner = createRunner();
  });

  afterAll(async () => {
    await cleanup(false);
  });

  describe('Capability Restrictions', () => {
    test('should drop NET_ADMIN capability after iptables setup', async () => {
      // After PR #133, CAP_NET_ADMIN is dropped after iptables setup
      // User commands should not be able to modify iptables rules
      const result = await runner.runWithSudo(
        'iptables -t nat -L OUTPUT 2>&1 || echo "iptables command failed as expected"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      // iptables should fail due to lack of CAP_NET_ADMIN
      expect(result.stdout).toContain('iptables command failed as expected');
    }, 120000);

    test('should block iptables flush attempt', async () => {
      const result = await runner.runWithSudo(
        'iptables -t nat -F OUTPUT 2>&1 || echo "flush blocked"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('flush blocked');
    }, 120000);

    test('should block iptables delete attempt', async () => {
      const result = await runner.runWithSudo(
        'iptables -t nat -D OUTPUT 1 2>&1 || echo "delete blocked"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('delete blocked');
    }, 120000);

    test('should block iptables insert attempt', async () => {
      const result = await runner.runWithSudo(
        'iptables -t nat -I OUTPUT -j ACCEPT 2>&1 || echo "insert blocked"',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
      expect(result.stdout).toContain('insert blocked');
    }, 120000);
  });

  describe('Firewall Bypass Prevention', () => {
    test('should block CONNECT domain fronting with a different TLS SNI', async () => {
      const result = await runner.runWithSudo(
        `python3 - <<'PY'
import os
import socket
import ssl

proxy_host = os.environ['SQUID_PROXY_HOST']
proxy_port = int(os.environ['SQUID_PROXY_PORT'])
sock = socket.create_connection((proxy_host, proxy_port), timeout=10)
sock.sendall(
    b'CONNECT nodejs.org:443 HTTP/1.1\\r\\n'
    b'Host: nodejs.org:443\\r\\n'
    b'Connection: close\\r\\n\\r\\n'
)

response = b''
while b'\\r\\n\\r\\n' not in response:
    chunk = sock.recv(4096)
    if not chunk:
        raise SystemExit('proxy closed before responding to CONNECT')
    response += chunk

if b' 200 ' not in response.split(b'\\r\\n', 1)[0]:
    raise SystemExit('allowed CONNECT target was rejected')

try:
    ssl._create_unverified_context().wrap_socket(sock, server_hostname='example.com')
except (ssl.SSLError, ConnectionError, OSError):
    raise SystemExit(0)

raise SystemExit('TLS handshake with non-allowlisted SNI unexpectedly succeeded')
PY`,
        {
          allowDomains: ['nodejs.org'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toSucceed();
    }, 120000);

    test('should block curl --connect-to bypass', async () => {
      const result = await runner.runWithSudo(
        'curl -f --connect-to ::github.com: https://example.com --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block NO_PROXY environment variable bypass', async () => {
      const result = await runner.runWithSudo(
        "env NO_PROXY='*' curl -f https://example.com --max-time 5",
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block ALL_PROXY bypass attempt', async () => {
      const result = await runner.runWithSudo(
        "env ALL_PROXY='' curl -f https://example.com --max-time 5",
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });

  describe('SSRF Protection', () => {
    test('should block AWS metadata endpoint', async () => {
      const result = await runner.runWithSudo(
        'curl -f http://169.254.169.254 --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block AWS metadata endpoint with path', async () => {
      const result = await runner.runWithSudo(
        'curl -f http://169.254.169.254/latest/meta-data/ --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block GCP metadata endpoint', async () => {
      const result = await runner.runWithSudo(
        'curl -f "http://metadata.google.internal/computeMetadata/v1/" -H "Metadata-Flavor: Google" --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block Azure metadata endpoint', async () => {
      const result = await runner.runWithSudo(
        'curl -f "http://169.254.169.254/metadata/instance" -H "Metadata: true" --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });

  describe('DNS Security', () => {
    test('should block DNS over HTTPS (DoH)', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://cloudflare-dns.com/dns-query --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);

    test('should block Google DoH endpoint', async () => {
      const result = await runner.runWithSudo(
        'curl -f https://dns.google/dns-query --max-time 5',
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      expect(result).toFail();
    }, 120000);
  });

  describe('Firewall Effectiveness After Bypass Attempt', () => {
    test('should maintain firewall after iptables bypass attempt', async () => {
      // Attempt to flush iptables rules (should fail due to dropped NET_ADMIN)
      // Then verify the firewall still blocks non-whitelisted domains
      const result = await runner.runWithSudo(
        "bash -c 'iptables -t nat -F OUTPUT 2>/dev/null; curl -f https://example.com --max-time 5'",
        {
          allowDomains: ['github.com'],
          logLevel: 'debug',
          timeout: 60000,
        }
      );

      // Should fail because:
      // 1. iptables flush fails (no CAP_NET_ADMIN)
      // 2. curl to example.com is blocked by Squid
      expect(result).toFail();
    }, 120000);
  });
});
