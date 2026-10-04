import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { enforceDocsAudit, validateAcceptance } from './enforce-docs-audit';
import acceptance from '../../docs-site/audit-allowlist.json';

const now = new Date('2026-10-03T17:00:00Z');
const acceptedVia = {
  name: 'http-cache-semantics',
  dependency: 'http-cache-semantics',
  url: 'https://github.com/advisories/GHSA-ch52-4w7c-c8xp',
};

function report() {
  return {
    auditReportVersion: 2,
    vulnerabilities: {
      'http-cache-semantics': { severity: 'high', via: [acceptedVia] },
      astro: { severity: 'high', via: ['http-cache-semantics'] },
      '@astrojs/mdx': { severity: 'high', via: ['astro'] },
      '@astrojs/starlight': { severity: 'high', via: ['astro', '@astrojs/mdx'] },
    },
    metadata: { vulnerabilities: { high: 4, critical: 0 } },
  };
}

describe('docs-only advisory acceptance', () => {
  it('accepts only the approved advisory and its transitive parent findings', () => {
    expect(acceptance.advisory).toBe('GHSA-ch52-4w7c-c8xp');
    expect(acceptance.package).toBe('http-cache-semantics');
    expect(acceptance.expires).toBe('2027-01-03');
    expect(() => enforceDocsAudit(report(), acceptance, now)).not.toThrow();
    expect(() => validateAcceptance({ ...acceptance, advisory: 'GHSA-other' }, now)).toThrow();
  });

  it.each(['high', 'critical'])('still rejects unrelated %s findings', (severity) => {
    const audit = report();
    const extra = {
      severity,
      via: [{ ...acceptedVia, url: 'https://github.com/advisories/GHSA-other' }],
    };
    const counts = { high: 4 + Number(severity === 'high'), critical: Number(severity === 'critical') };
    expect(() => enforceDocsAudit({
      ...audit,
      vulnerabilities: { ...audit.vulnerabilities, other: extra },
      metadata: { vulnerabilities: counts },
    }, acceptance, now)).toThrow('other');
  });

  it('rejects mixed advisories, unknown references, empty chains, cycles and wrong packages', () => {
    for (const via of [
      [acceptedVia, { ...acceptedVia, url: 'https://github.com/advisories/GHSA-other' }],
      ['missing'],
      [],
      ['astro'],
      [{ ...acceptedVia, dependency: 'other' }],
    ]) {
      const audit = report();
      expect(() => enforceDocsAudit({
        ...audit,
        vulnerabilities: {
          ...audit.vulnerabilities, 'http-cache-semantics': { severity: 'high', via },
        },
      }, acceptance, now)).toThrow('Unaccepted');
    }
  });

  it('fails closed on malformed reports and inconsistent severity counts', () => {
    for (const audit of [
      {},
      { ...report(), error: { message: 'service failure' } },
      { ...report(), metadata: { vulnerabilities: { high: 0, critical: 0 } } },
      { ...report(), vulnerabilities: { broken: { severity: 'unknown' } } },
    ]) {
      expect(() => enforceDocsAudit(audit, acceptance, now)).toThrow();
    }
  });

  it('returns a failing CLI exit code for synthetic JSON with another high', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-docs-audit-'));
    try {
      const audit = report();
      const reportPath = path.join(directory, 'audit.json');
      const acceptancePath = path.join(directory, 'allowlist.json');
      fs.writeFileSync(acceptancePath, JSON.stringify({ ...acceptance, expires: '9999-01-01' }));
      fs.writeFileSync(reportPath, JSON.stringify({
        ...audit,
        vulnerabilities: {
          ...audit.vulnerabilities,
          other: {
            severity: 'high',
            via: [{ ...acceptedVia, url: 'https://github.com/advisories/GHSA-other' }],
          },
        },
        metadata: { vulnerabilities: { high: 5, critical: 0 } },
      }));
      const result = spawnSync(process.execPath, [
        require.resolve('tsx/cli'), path.join(__dirname, 'enforce-docs-audit.ts'), reportPath,
        acceptancePath,
      ], { encoding: 'utf8' });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('other (high)');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('enforces the UTC expiry even for a clean report and rejects invalid dates', () => {
    const clean = {
      auditReportVersion: 2, vulnerabilities: {},
      metadata: { vulnerabilities: { high: 0, critical: 0 } },
    };
    expect(() => enforceDocsAudit(clean, acceptance, new Date('2027-01-02T23:59:59Z'))).not.toThrow();
    for (const date of ['2027-01-03T00:00:00Z', '2027-01-04T00:00:00Z']) {
      expect(() => enforceDocsAudit(clean, acceptance, new Date(date))).toThrow('expired');
    }
    expect(() => validateAcceptance({ ...acceptance, expires: '2027-02-30' }, now)).toThrow();
  });

  it('wires the exception only into docs enforcement, before unchanged service-error handling', () => {
    const workflow = yaml.load(fs.readFileSync(
      path.join(__dirname, '../../.github/workflows/dependency-audit.yml'), 'utf8',
    )) as { jobs: Record<string, { steps: Array<{ name: string; run?: string }> }> };
    const rootPackage = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../package.json'), 'utf8',
    )) as { devDependencies: { tsx: string } };
    const main = workflow.jobs['audit-main'].steps.find((step) => step.name.startsWith('Enforce'))?.run;
    const docs = workflow.jobs['audit-docs'].steps.find((step) => step.name.startsWith('Enforce'))?.run;
    expect(main).not.toContain('enforce-docs-audit');
    expect(main).toContain('(.metadata.vulnerabilities.high == 0)');
    expect(main).toContain('(.metadata.vulnerabilities.critical == 0)');
    expect(docs).toContain('npm-audit-docs.json audit-allowlist.json');
    expect(docs?.match(/npx --yes tsx@\S+/g)).toEqual([
      `npx --yes tsx@${rootPackage.devDependencies.tsx}`,
      `npx --yes tsx@${rootPackage.devDependencies.tsx}`,
    ]);
    expect(docs?.indexOf('--check-allowlist')).toBeLessThan(docs?.indexOf("if jq -e '.error'") ?? -1);
    for (const script of [main, docs]) {
      expect(script).toContain('echo "::warning::npm audit advisory service unavailable after retries"');
      expect(script).toContain('test "$EVENT_NAME" = "pull_request"\n  exit');
    }
  });
});
