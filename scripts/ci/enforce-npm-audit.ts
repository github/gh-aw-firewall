import * as fs from 'fs';

const allowed = new Set([
  'astro:GHSA-mh32-jxcr-mh9f',
  'astro:GHSA-r3h5-4585-7x3w',
  'picomatch:GHSA-fc5q-39xc-vjpf',
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface Acceptance {
  advisory: string;
  package: string;
  expires: string;
  reason: string;
}

export function validateAcceptances(value: unknown, now = new Date()): Acceptance[] {
  if (!record(value) || !Array.isArray(value.acceptances) ||
      value.acceptances.length === 0 || value.acceptances.length > allowed.size) {
    throw new Error('Invalid npm audit acceptances');
  }
  const seen = new Set<string>();
  const acceptances = value.acceptances.map((entry: unknown) => {
    if (!record(entry) || typeof entry.advisory !== 'string' ||
        typeof entry.package !== 'string' || typeof entry.reason !== 'string' ||
        !entry.reason.trim() || typeof entry.expires !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires)) {
      throw new Error('Invalid npm audit acceptance entry');
    }
    const key = `${entry.package}:${entry.advisory}`;
    const expiry = new Date(`${entry.expires}T00:00:00Z`);
    if (!allowed.has(key) || seen.has(key) || !Number.isFinite(expiry.getTime()) ||
        expiry.toISOString().slice(0, 10) !== entry.expires ||
        !Number.isFinite(now.getTime()) || now >= expiry) {
      throw new Error(`Unsupported, duplicate, expired or invalid npm audit acceptance: ${key}`);
    }
    seen.add(key);
    return entry as unknown as Acceptance;
  });
  return acceptances;
}

export function enforceNpmAudit(report: unknown, config: unknown, now = new Date()): void {
  const acceptances = validateAcceptances(config, now);
  const acceptedKeys = new Set(acceptances.map((entry) => `${entry.package}:${entry.advisory}`));
  if (!record(report) || report.error || report.auditReportVersion !== 2 ||
      !record(report.vulnerabilities) || !record(report.metadata) ||
      !record(report.metadata.vulnerabilities)) {
    throw new Error('Invalid npm audit report');
  }
  const vulnerabilities = report.vulnerabilities;
  const counts = report.metadata.vulnerabilities;
  const entries = Object.entries(vulnerabilities);
  for (const [name, entry] of entries) {
    if (!record(entry) || !['info', 'low', 'moderate', 'high', 'critical'].includes(String(entry.severity))) {
      throw new Error(`Invalid npm audit vulnerability: ${name}`);
    }
  }

  function accepted(name: string, ancestors = new Set<string>()): boolean {
    const entry = vulnerabilities[name];
    if (ancestors.has(name) || !record(entry) || !Array.isArray(entry.via) || !entry.via.length) {
      return false;
    }
    const next = new Set(ancestors).add(name);
    return entry.via.every((via: unknown) => {
      if (typeof via === 'string') {
        const dependency = vulnerabilities[via];
        return record(dependency) &&
          (!['high', 'critical'].includes(String(dependency.severity)) || accepted(via, next));
      }
      return record(via) &&
        (!['high', 'critical'].includes(String(via.severity)) ||
          (typeof via.url === 'string' && typeof via.name === 'string' &&
            via.dependency === via.name &&
            acceptedKeys.has(`${via.name}:${via.url.replace('https://github.com/advisories/', '')}`)));
    });
  }

  const blocked: string[] = [];
  for (const severity of ['high', 'critical']) {
    const findings = entries.filter(([, entry]) => record(entry) && entry.severity === severity);
    if (counts[severity] !== findings.length) {
      throw new Error(`Inconsistent npm audit ${severity} count`);
    }
    for (const [name] of findings) {
      if (!accepted(name)) {
        blocked.push(`${name} (${severity})`);
      }
    }
  }
  if (blocked.length) {
    throw new Error(`Unaccepted high/critical npm vulnerabilities: ${blocked.join(', ')}`);
  }
}

if (require.main === module) {
  try {
    const [, , reportPath, configPath] = process.argv;
    const config = configPath ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : undefined;
    if (reportPath === '--check-allowlist') {
      validateAcceptances(config);
    } else if (reportPath) {
      enforceNpmAudit(JSON.parse(fs.readFileSync(reportPath, 'utf8')), config);
    } else {
      throw new Error('Usage: enforce-npm-audit.ts <audit.json|--check-allowlist> <allowlist.json>');
    }
    console.log('npm audit acceptance/enforcement passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
