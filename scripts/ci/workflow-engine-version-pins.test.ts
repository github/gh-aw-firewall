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
});
