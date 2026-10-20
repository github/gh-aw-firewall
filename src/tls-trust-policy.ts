import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';

// October 2026 eMudhra disclosure: eight compromised keys, followed by the
// four issuing/cross-signing roots. Root distrust is an emergency fallback for
// clients without chain-level SPKI revocation, including OpenSSL and Node.
// Sources: https://emudhra.we-have-a-problem.com/{impacted-intermediates,roots}.json
export const distrustedSpkis = new Set([
  '43bffa19d6ef651451f6841e019931e96f6f2eaeff28ab4b6f1ce4576de2717b',
  '49dd353dc2b919a3770645117d0e60c16115e7d1bc259eefe734b00ea434fe5f',
  '5c0660a2b164910d8ff589c18e14552e9e0ec237dcefe2cb736d41a4811f81a0',
  '63ecefee431d49523bc1136c4e72d0206a477086caf606cd5cf025686c109cf8',
  '92c063d67e8f14db71d288e11266ffdaf69cbf115f7bab14f3bc2f68d25e0e30',
  'e0254c7fcdc265e2f0f8a428dabb75ab4ae039b4872d62f5ee57f0877d5a8a41',
  'ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105',
  'ec4ffa1ad0ac88081314b7aaffef6a91f97cd57291bb5ba686c5415f5eb4f6b6',
  'c619e4780ed8e0abeda24ad732567de4383a7ea941338f6d1a7d1b49ac792fe9',
  '0a6c2b2ca5b364207954171987ac9d2178561569d8205457e77ca90c32ede282',
  'bd153ed7b0434f6886b17bce8bbe84ed340c7132d702a8f4fa318f756ecbd6f3',
  '8d417db2dd8bf5e3084d1e3f196d583849d81bdd4c00c70b9d39369e96b8c782',
]);

const certificateCache = new Map<string, boolean>();

function readSelectedOpenSslCertificates(): string[] {
  const variables = process.config.variables as unknown as Record<string, string | undefined>;
  let openSslDir: string | undefined;
  if ((!variables.openssl_default_cert_file && process.env.SSL_CERT_FILE === undefined)
      || (!variables.openssl_default_cert_dir && process.env.SSL_CERT_DIR === undefined)) {
    const output = execFileSync('openssl', ['version', '-d'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const match = output.match(/^OPENSSLDIR: "([^"]+)"$/m);
    if (!match) throw new Error('Unable to determine OpenSSL default CA paths');
    openSslDir = match[1];
  }
  const file = process.env.SSL_CERT_FILE
    ?? variables.openssl_default_cert_file
    ?? path.join(openSslDir!, 'cert.pem');
  const dirList = process.env.SSL_CERT_DIR
    ?? variables.openssl_default_cert_dir
    ?? path.join(openSslDir!, 'certs');
  const dirs = dirList.split(path.delimiter).filter(Boolean);
  const certificates: string[] = [];
  if (file) {
    try {
      certificates.push(readFileSync(file, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!/^[a-f0-9]{8}\.\d+$/i.test(entry)) continue;
      const candidate = path.join(dir, entry);
      try {
        // Pin the check/read to one handle without blocking on an unexpected FIFO.
        const descriptor = openSync(candidate, constants.O_RDONLY | constants.O_NONBLOCK);
        try {
          if (fstatSync(descriptor).isFile()) certificates.push(readFileSync(descriptor, 'utf8'));
        } finally {
          closeSync(descriptor);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  return certificates;
}

export function filterCaCertificates(
  ca: NonNullable<tls.SecureContextOptions['ca']>,
): string[] {
  const inputs = Array.isArray(ca) ? ca : [ca];
  return inputs.flatMap(input => {
    const text = input.toString();
    if (!text.trim()) return [];
    const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates || text.includes('-----BEGIN TRUSTED CERTIFICATE-----')) {
      throw new Error('AWF trust policy requires PEM CERTIFICATE entries');
    }
    return certificates.filter(pem => {
      let allowed = certificateCache.get(pem);
      if (allowed === undefined) {
        const certificate = new X509Certificate(pem);
        const spki = certificate.publicKey.export({ type: 'spki', format: 'der' });
        allowed = !distrustedSpkis.has(createHash('sha256').update(spki).digest('hex'));
        certificateCache.set(pem, allowed);
      }
      return allowed;
    });
  });
}

let installed = false;

export function applyTlsTrustPolicy(): void {
  if (installed) return;
  const usesOpenSslCa = /(?:^|\s)--use-openssl-ca(?:\s|$)/.test(
    `${process.execArgv.join(' ')} ${process.env.NODE_OPTIONS || ''}`,
  );
  const defaults = usesOpenSslCa
    ? readSelectedOpenSslCertificates()
    : tls.getCACertificates ? [...tls.getCACertificates('default')] : [...tls.rootCertificates];
  // Read explicitly as well: Node otherwise warns and ignores malformed or
  // missing NODE_EXTRA_CA_CERTS, which must not silently defeat private trust.
  if (process.env.NODE_EXTRA_CA_CERTS) {
    defaults.push(readFileSync(process.env.NODE_EXTRA_CA_CERTS, 'utf8'));
  }
  const filteredDefaults = filterCaCertificates(defaults);
  if (filteredDefaults.length === 0) throw new Error('AWF trust policy produced an empty default CA store');
  tls.setDefaultCACertificates?.(filteredDefaults);
  const createSecureContext = tls.createSecureContext;
  // Also cover explicit custom CA options and Node versions predating the
  // default-CA API. This affects https, fetch/undici and direct tls.connect.
  tls.createSecureContext = (options = {}) => {
    const normalizedOptions = options ?? {};
    return createSecureContext({
      ...normalizedOptions,
      ca: normalizedOptions.ca
        ? filterCaCertificates(normalizedOptions.ca) : filteredDefaults,
    });
  };
  installed = true;
}

applyTlsTrustPolicy();
