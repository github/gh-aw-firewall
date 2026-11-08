import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

type Step = {
  name: string;
  id?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
};
type Job = {
  'runs-on': string;
  needs: string | string[];
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast': boolean; matrix: { include: { arch: string; runner: string }[] } };
  steps: Step[];
};

const root = path.resolve(__dirname, '../..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};
const build = workflow.jobs['build-squid-platform'];
const publish = workflow.jobs['build-squid'];
const exportStep = build.steps.find(step => step.name === 'Export Squid image digest')!;
const manifestStep = publish.steps.find(step => step.id === 'build_squid')!;
const image = 'ghcr.io/github/gh-aw-firewall/squid';
const digests = { amd64: `sha256:${'a'.repeat(64)}`, arm64: `sha256:${'b'.repeat(64)}` };
const manifestDigest = `sha256:${'c'.repeat(64)}`;
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-squid-release-'));
let sequence = 0;

function fixture() {
  const directory = path.join(scratch, String(sequence++));
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args.slice(0, 3).join(' ') === 'buildx imagetools create') {
  process.exit(Number(process.env.CREATE_STATUS || 0));
}
if (args.slice(0, 3).join(' ') !== 'buildx imagetools inspect') process.exit(91);
if (process.env.INSPECT_STATUS) process.exit(Number(process.env.INSPECT_STATUS));
if (args.includes('--raw')) {
  console.log(JSON.stringify({ manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    ...(process.env.MISSING_ARM64 ? [] : [{ platform: { os: 'linux', architecture: 'arm64' } }]),
    { platform: { os: 'unknown', architecture: 'unknown' } }
  ] }));
} else {
  console.log(process.env.MANIFEST_DIGEST || ${JSON.stringify(manifestDigest)});
}
`, { mode: 0o755 });
  const output = path.join(directory, 'output');
  const dockerLog = path.join(directory, 'docker.log');
  function run(script: string, overrides: Record<string, string> = {}) {
    return spawnSync('bash', ['-e', '-c', script], {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        RUNNER_TEMP: directory,
        GITHUB_OUTPUT: output,
        DOCKER_LOG: dockerLog,
        IMAGE: image,
        VERSION: '1.2.3',
        ...overrides,
      },
    });
  }
  return {
    directory,
    run,
    export(arch: string, digest: string) {
      return run(exportStep.run!, { ARCH: arch, DIGEST: digest });
    },
    commands(): string[][] {
      return fs.existsSync(dockerLog)
        ? fs.readFileSync(dockerLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
        : [];
    },
    output() {
      return fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '';
    },
  };
}

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('native Squid release builds', () => {
  it('builds each architecture natively with isolated caches and no QEMU', () => {
    expect(build['runs-on']).toBe('${{ matrix.runner }}');
    expect(build.needs).toBe('bump-version');
    expect(build.strategy).toEqual({
      'fail-fast': false,
      matrix: { include: [
        { arch: 'amd64', runner: 'ubuntu-24.04' },
        { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
      ] },
    });
    expect(build.steps.some(step => step.uses?.startsWith('docker/setup-qemu-action@'))).toBe(false);
    const checkout = build.steps.find(step => step.uses?.startsWith('actions/checkout@'))!;
    expect(checkout.with?.ref).toBe('${{ needs.bump-version.outputs.version }}');
    const imageBuild = build.steps.find(step => step.id === 'build_squid')!;
    expect(imageBuild.with).toEqual({
      context: './containers/squid',
      platforms: 'linux/${{ matrix.arch }}',
      outputs: 'type=image,name=ghcr.io/${{ github.repository }}/squid,push-by-digest=true,name-canonical=true,push=true',
      'cache-from': 'type=gha,scope=squid-${{ matrix.arch }}',
      'cache-to': 'type=gha,mode=max,scope=squid-${{ matrix.arch }}',
    });
    expect(exportStep.env).toEqual({
      DIGEST: '${{ steps.build_squid.outputs.digest }}', ARCH: '${{ matrix.arch }}',
    });
  });

  it('hands off distinct architecture artifacts and preserves downstream digest consumers', () => {
    const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))!;
    expect(upload.with).toMatchObject({
      name: 'squid-digest-${{ matrix.arch }}',
      path: '${{ runner.temp }}/squid-digests/${{ matrix.arch }}',
      'if-no-files-found': 'error',
    });
    const download = publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))!;
    expect(download.with).toEqual({
      pattern: 'squid-digest-*', path: '${{ runner.temp }}/squid-digests', 'merge-multiple': true,
    });
    expect(publish.needs).toEqual(['bump-version', 'build-squid-platform']);
    expect(publish.outputs?.digest).toBe('${{ steps.build_squid.outputs.digest }}');
    expect(manifestStep.env).toEqual({
      IMAGE: 'ghcr.io/${{ github.repository }}/squid',
      VERSION: '${{ needs.bump-version.outputs.version_number }}',
    });
    for (const name of ['Sign Squid image with cosign', 'Attest SBOM for Squid image']) {
      expect(publish.steps.find(step => step.name === name)?.run)
        .toContain('ghcr.io/${{ github.repository }}/squid@${{ steps.build_squid.outputs.digest }}');
    }
    expect(publish.steps.find(step => step.name === 'Generate SBOM for Squid image')?.with?.image)
      .toBe('ghcr.io/${{ github.repository }}/squid@${{ steps.build_squid.outputs.digest }}');
    const consumer = Object.values(workflow.jobs).find(job =>
      job.steps.some(step => step.name === 'Generate containers list'))!;
    expect(consumer.needs).toContain('build-squid');
    expect(consumer.steps.find(step => step.name === 'Generate containers list')?.run)
      .toContain("ghcr.io/${{ github.repository }}/squid@${{ needs['build-squid'].outputs.digest }}");
  });

  it('executes the digest handoff and publishes both tags from both immutable sources', () => {
    const test = fixture();
    for (const [arch, digest] of Object.entries(digests)) {
      expect(test.export(arch, digest).status).toBe(0);
      expect(fs.readFileSync(path.join(test.directory, 'squid-digests', arch), 'utf8')).toBe(`${digest}\n`);
    }
    const result = test.run(manifestStep.run!);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(test.commands()).toEqual([
      ['buildx', 'imagetools', 'create', '--tag', `${image}:1.2.3`, '--tag', `${image}:latest`,
        `${image}@${digests.amd64}`, `${image}@${digests.arm64}`],
      ['buildx', 'imagetools', 'inspect', `${image}:1.2.3`, '--format', '{{.Manifest.Digest}}'],
      ['buildx', 'imagetools', 'inspect', `${image}@${manifestDigest}`, '--raw'],
    ]);
    expect(test.output()).toBe(`digest=${manifestDigest}\n`);
  });

  it('rejects invalid build digests before writing an artifact', () => {
    const test = fixture();
    expect(test.export('arm64', 'not-a-digest').status).not.toBe(0);
    expect(fs.existsSync(path.join(test.directory, 'squid-digests', 'arm64'))).toBe(false);
  });

  it.each(['missing', 'invalid'])('rejects a %s architecture digest before registry writes', kind => {
    const test = fixture();
    expect(test.export('amd64', digests.amd64).status).toBe(0);
    if (kind === 'invalid') fs.writeFileSync(path.join(test.directory, 'squid-digests', 'arm64'), 'invalid\n');
    const result = test.run(manifestStep.run!);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('::error::');
    expect(test.commands()).toEqual([]);
    expect(test.output()).toBe('');
  });

  it.each<Record<string, string>>([
    { CREATE_STATUS: '1' },
    { INSPECT_STATUS: '1' },
    { MANIFEST_DIGEST: 'invalid' },
    { MISSING_ARM64: '1' },
  ])('does not expose a successful digest after publication or verification failure: %j', overrides => {
    const test = fixture();
    for (const [arch, digest] of Object.entries(digests)) expect(test.export(arch, digest).status).toBe(0);
    expect(test.run(manifestStep.run!, overrides).status).not.toBe(0);
    expect(test.output()).toBe('');
  });
});
