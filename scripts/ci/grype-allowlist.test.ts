import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');

interface IgnoreEntry {
  vulnerability: string;
  package?: {
    name?: string;
    version?: string;
    type?: string;
  };
}

test('keeps current Grype exceptions scoped to the observed vulnerable package versions', () => {
  const config = yaml.load(fs.readFileSync(path.join(root, '.grype.yaml'), 'utf8')) as {
    ignore: IgnoreEntry[];
  };
  const vulnerabilities = [
    'CVE-2026-95692',
    'CVE-2026-107496',
    'CVE-2026-95691',
    'CVE-2026-88823',
    'CVE-2026-124709',
    'CVE-2026-107494',
    'CVE-2026-121482',
    'CVE-2026-84786',
    'CVE-2026-107493',
    'GHSA-fc5q-39xc-vjpf',
  ];
  const actual = config.ignore
    .filter(entry => vulnerabilities.includes(entry.vulnerability))
    .map(entry => [
      entry.vulnerability,
      entry.package?.name,
      entry.package?.version,
      entry.package?.type,
    ].join(':'))
    .sort();
  const expected = [
    ...['CVE-2026-95692', 'CVE-2026-107496', 'CVE-2026-95691', 'CVE-2026-88823']
      .flatMap(vulnerability => ['3.5.9-r0', '3.5.9-r1']
        .flatMap(version => ['libcrypto3', 'libssl3', 'openssl']
          .map(name => `${vulnerability}:${name}:${version}:apk`))),
    ...[
      'CVE-2026-124709',
      'CVE-2026-107494',
      'CVE-2026-121482',
      'CVE-2026-84786',
      'CVE-2026-107493',
    ].flatMap(vulnerability => ['libcrypto3', 'libssl3', 'openssl']
      .map(name => `${vulnerability}:${name}:3.5.9-r1:apk`)),
    'GHSA-fc5q-39xc-vjpf:picomatch:4.0.5:npm',
  ].sort();

  expect(actual).toEqual(expected);
});
