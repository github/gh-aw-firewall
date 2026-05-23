import { DANGEROUS_PORTS } from './policy-manifest';

export function validateApiProxyIp(apiProxyIp?: string): void {
  if (apiProxyIp === undefined) {
    return;
  }

  const octet = '(?:25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]\\d|\\d)';
  const ipv4Re = new RegExp(`^(?:${octet}\\.){3}${octet}$`);
  if (!ipv4Re.test(apiProxyIp)) {
    throw new Error(`SECURITY: apiProxyIp must be a valid IPv4 address (0-255 octets), got: ${JSON.stringify(apiProxyIp)}`);
  }
}

export function validateAndSanitizeHostAccessPort(port: string): string {
  const parts = port.split('-');
  if (parts.length === 2 && parts[0] !== '' && parts[1] !== '') {
    const start = parseInt(parts[0], 10);
    const end = parseInt(parts[1], 10);

    if (isNaN(start) || isNaN(end) || start < 1 || end > 65535 || start > end) {
      throw new Error(`Invalid port range: ${port}. Must be in format START-END where 1 <= START <= END <= 65535`);
    }

    for (let p = start; p <= end; p++) {
      if (DANGEROUS_PORTS.includes(p)) {
        throw new Error(
          `Port range ${port} includes dangerous port ${p} which is blocked for security reasons. ` +
          `Dangerous ports (SSH, databases, etc.) cannot be allowed even with --allow-host-ports.`
        );
      }
    }
  } else {
    const portNum = parseInt(port, 10);

    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Invalid port: ${port}. Must be a number between 1 and 65535`);
    }

    if (DANGEROUS_PORTS.includes(portNum)) {
      throw new Error(
        `Port ${portNum} is blocked for security reasons. ` +
        `Dangerous ports (SSH:22, MySQL:3306, PostgreSQL:5432, etc.) cannot be allowed even with --allow-host-ports.`
      );
    }
  }

  return port.replace(/[^0-9-]/g, '');
}

export function validateApiProxyPort(proxyPort: number): void {
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    throw new Error(`Invalid api-proxy port: ${proxyPort}. Must be an integer between 1 and 65535`);
  }

  if (DANGEROUS_PORTS.includes(proxyPort)) {
    throw new Error(
      `Api-proxy port ${proxyPort} is blocked for security reasons. ` +
      `Dangerous ports (SSH, databases, etc.) cannot be added to Safe_ports.`
    );
  }
}
