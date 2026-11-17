import rootAcceptances from '../../audit-allowlist.json';
import docsAcceptances from '../../docs-site/audit-allowlist.json';
import { enforceNpmAudit, validateAcceptances } from './enforce-npm-audit';

const now = new Date('2026-11-17T20:00:00Z');
const advisory = (name: string, id: string) => ({
  name,
  dependency: name,
  url: `https://github.com/advisories/${id}`,
  severity: 'high',
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

describe('npm audit acceptance', () => {
  it('accepts only the configured advisories and their transitive findings', () => {
    expect(() => enforceNpmAudit(report(), docsAcceptances, now)).not.toThrow();
    expect(() => validateAcceptances({
      acceptances: [...rootAcceptances.acceptances, ...rootAcceptances.acceptances],
    }, now)).toThrow('duplicate');
  });

  it('supports the narrower root-package acceptance', () => {
    const rootReport = {
      auditReportVersion: 2,
      vulnerabilities: {
        picomatch: {
          severity: 'high',
          via: [advisory('picomatch', 'GHSA-fc5q-39xc-vjpf')],
        },
        glob: {
          severity: 'moderate',
          via: [{ ...advisory('glob', 'GHSA-moderate'), severity: 'moderate' }],
        },
        jest: {
          severity: 'high',
          via: ['picomatch', 'glob'],
        },
      },
      metadata: { vulnerabilities: { high: 2, critical: 0 } },
    };
    expect(() => enforceNpmAudit(rootReport, rootAcceptances, now)).not.toThrow();
  });

  it.each(['high', 'critical'])('rejects unrelated %s findings', (severity) => {
    const audit = report();
    expect(() => enforceNpmAudit({
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
    }, docsAcceptances, now)).toThrow(`other (${severity})`);
  });

  it('fails closed on malformed reports, cycles and inconsistent counts', () => {
    expect(() => enforceNpmAudit({}, docsAcceptances, now)).toThrow('Invalid npm audit report');
    expect(() => enforceNpmAudit({
      ...report(),
      vulnerabilities: { astro: { severity: 'high', via: ['astro'] } },
      metadata: { vulnerabilities: { high: 1, critical: 0 } },
    }, docsAcceptances, now)).toThrow('Unaccepted');
    expect(() => enforceNpmAudit({
      ...report(),
      metadata: { vulnerabilities: { high: 0, critical: 0 } },
    }, docsAcceptances, now)).toThrow('Inconsistent');
  });

  it('enforces the UTC expiry', () => {
    expect(() => enforceNpmAudit(
      report(), docsAcceptances, new Date('2026-11-30T23:59:59Z'),
    )).not.toThrow();
    expect(() => enforceNpmAudit(
      report(), docsAcceptances, new Date('2026-12-01T00:00:00Z'),
    )).toThrow('expired');
  });
});
