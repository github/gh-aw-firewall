import acceptances from '../../docs-site/audit-allowlist.json';
import { enforceDocsAudit, validateAcceptances } from './enforce-docs-audit';

const now = new Date('2026-11-17T20:00:00Z');
const advisory = (name: string, id: string) => ({
  name,
  dependency: name,
  url: `https://github.com/advisories/${id}`,
});

function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      astro: {
        severity: 'high',
        via: [
          advisory('astro', 'GHSA-mh32-jxcr-mh9f'),
          advisory('astro', 'GHSA-r3h5-4585-7x3w'),
        ],
      },
      picomatch: {
        severity: 'high',
        via: [advisory('picomatch', 'GHSA-fc5q-39xc-vjpf')],
      },
      '@astrojs/mdx': { severity: 'high', via: ['astro', 'picomatch'] },
    },
    metadata: { vulnerabilities: { high: 3, critical: 0 } },
  };
}

describe('docs audit acceptance', () => {
  it('accepts only the configured advisories and their transitive findings', () => {
    expect(() => enforceDocsAudit(report(), acceptances, now)).not.toThrow();
    expect(() => validateAcceptances({
      acceptances: acceptances.acceptances.slice(1),
    }, now)).toThrow();
  });

  it.each(['high', 'critical'])('rejects unrelated %s findings', (severity) => {
    const audit = report();
    expect(() => enforceDocsAudit({
      ...audit,
      vulnerabilities: {
        ...audit.vulnerabilities,
        other: { severity, via: [advisory('other', 'GHSA-other')] },
      },
      metadata: {
        vulnerabilities: {
          high: 3 + Number(severity === 'high'),
          critical: Number(severity === 'critical'),
        },
      },
    }, acceptances, now)).toThrow(`other (${severity})`);
  });

  it('fails closed on malformed reports, cycles and inconsistent counts', () => {
    expect(() => enforceDocsAudit({}, acceptances, now)).toThrow('Invalid npm audit report');
    expect(() => enforceDocsAudit({
      ...report(),
      vulnerabilities: { astro: { severity: 'high', via: ['astro'] } },
      metadata: { vulnerabilities: { high: 1, critical: 0 } },
    }, acceptances, now)).toThrow('Unaccepted');
    expect(() => enforceDocsAudit({
      ...report(),
      metadata: { vulnerabilities: { high: 0, critical: 0 } },
    }, acceptances, now)).toThrow('Inconsistent');
  });

  it('enforces the UTC expiry', () => {
    expect(() => enforceDocsAudit(
      report(), acceptances, new Date('2026-11-30T23:59:59Z'),
    )).not.toThrow();
    expect(() => enforceDocsAudit(
      report(), acceptances, new Date('2026-12-01T00:00:00Z'),
    )).toThrow('expired');
  });
});
