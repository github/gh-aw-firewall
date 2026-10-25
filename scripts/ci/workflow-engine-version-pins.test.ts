import * as fs from 'fs';
import * as path from 'path';

const workflowsDir = path.resolve(__dirname, '../../.github/workflows');
const engineVersionPins = [
  { workflow: 'smoke-gemini', engine: 'gemini', version: '0.64.0', package: '@google/gemini-cli' },
  { workflow: 'smoke-codex', engine: 'codex', version: '0.163.0', package: '@openai/codex' },
  {
    workflow: 'smoke-cloud-hypervisor-codex',
    engine: 'codex',
    version: '0.163.0',
    package: '@openai/codex',
  },
  { workflow: 'secret-digger-codex', engine: 'codex', version: '0.163.0', package: '@openai/codex' },
];

describe('workflow engine CLI version pins', () => {
  it.each(engineVersionPins)(
    'keeps $workflow source and generated install pinned to $version',
    ({ workflow, engine, version, package: packageName }) => {
      const source = fs.readFileSync(path.join(workflowsDir, `${workflow}.md`), 'utf-8');
      const lock = fs.readFileSync(path.join(workflowsDir, `${workflow}.lock.yml`), 'utf-8');
      const metadataLine = lock.split('\n').find((line) => line.startsWith('# gh-aw-metadata: '));

      expect(source).toMatch(new RegExp(`\\bversion: "${version}"`));
      expect(metadataLine).toBeDefined();
      const metadata = JSON.parse(metadataLine!.slice('# gh-aw-metadata: '.length));
      expect(metadata.engine_versions[engine]).toBe(version);
      expect(lock).toContain(`${packageName}@${version}`);
    },
  );

  it('pins the enclave Issues smoke install to the Copilot 1.0.80 checksum manifest', () => {
    const source = fs.readFileSync(
      path.join(workflowsDir, 'smoke-enclave-issues-read.md'), 'utf-8',
    );
    const lock = fs.readFileSync(
      path.join(workflowsDir, 'smoke-enclave-issues-read.lock.yml'), 'utf-8',
    );
    const version = '1.0.80';
    const checksum = '243949dfde6b9c0d5852c4bc430f46ddcaacdfc74353bd1b1d2bccce3b789a48';
    const metadataLine = lock.split('\n').find(line => line.startsWith('# gh-aw-metadata: '));

    expect(source).toContain(`engine:\n  id: copilot\n  version: "${version}"\n  checksums-sha256: ${checksum}`);
    expect(JSON.parse(metadataLine!.slice('# gh-aw-metadata: '.length)).engine_versions.copilot)
      .toBe(version);
    expect(lock).toContain(`install_copilot_cli.sh" ${version} --checksums-sha256 ${checksum}`);
  });

  it.each(['dependency-security-monitor', 'test-coverage-reporter'])(
    'pins %s install to a trusted Copilot checksum manifest',
    workflow => {
      const source = fs.readFileSync(
        path.join(workflowsDir, `${workflow}.md`), 'utf-8',
      );
      const lock = fs.readFileSync(
        path.join(workflowsDir, `${workflow}.lock.yml`), 'utf-8',
      );
      const version = '1.0.101';
      const checksum = '018625eac68670d66ede904b9b82cdcd6ab8f87ba20e6e1fbdf0b62c8295d5be';
      const metadataLine = lock.split('\n').find(line => line.startsWith('# gh-aw-metadata: '));

      expect(source).toContain(`engine:\n  id: copilot\n  version: "${version}"\n  checksums-sha256: ${checksum}`);
      expect(JSON.parse(metadataLine!.slice('# gh-aw-metadata: '.length)).engine_versions.copilot)
        .toBe(version);
      expect(lock).toContain(`install_copilot_cli.sh" ${version} --checksums-sha256 ${checksum}`);
    },
  );
});
