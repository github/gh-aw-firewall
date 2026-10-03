import * as fs from 'fs';

const advisory = 'GHSA-ch52-4w7c-c8xp';
const packageName = 'http-cache-semantics';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateAcceptance(value: unknown, now = new Date()): void {
  if (!record(value) || value.advisory !== advisory || value.package !== packageName ||
      typeof value.reason !== 'string' || !value.reason.trim() ||
      typeof value.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.expires)) {
    throw new Error('Invalid docs audit acceptance: only GHSA-ch52-4w7c-c8xp is supported');
  }
  const expiry = new Date(`${value.expires}T00:00:00Z`);
  if (!Number.isFinite(expiry.getTime()) || expiry.toISOString().slice(0, 10) !== value.expires ||
      !Number.isFinite(now.getTime()) || now >= expiry) {
    throw new Error(`Docs audit acceptance expired or invalid: ${value.expires} (00:00 UTC)`);
  }
}

export function enforceDocsAudit(report: unknown, acceptance: unknown, now = new Date()): void {
  validateAcceptance(acceptance, now);
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
        return Object.prototype.hasOwnProperty.call(vulnerabilities, via) && accepted(via, next);
      }
      return record(via) && via.url === `https://github.com/advisories/${advisory}` &&
        via.name === packageName && via.dependency === packageName;
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
    throw new Error(`Unaccepted high/critical docs vulnerabilities: ${blocked.join(', ')}`);
  }
}

if (require.main === module) {
  try {
    const [, , reportPath, acceptancePath] = process.argv;
    if (reportPath === '--check-allowlist' && acceptancePath) {
      validateAcceptance(JSON.parse(fs.readFileSync(acceptancePath, 'utf8')));
    } else if (reportPath && acceptancePath) {
      enforceDocsAudit(
        JSON.parse(fs.readFileSync(reportPath, 'utf8')),
        JSON.parse(fs.readFileSync(acceptancePath, 'utf8')),
      );
    } else {
      throw new Error('Usage: enforce-docs-audit.ts <audit.json|--check-allowlist> <allowlist.json>');
    }
    console.log('Docs audit acceptance/enforcement passed');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
