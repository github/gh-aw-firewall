import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

type Step = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  shell?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
  'continue-on-error'?: boolean;
};
type Job = {
  needs?: string | string[];
  'runs-on': string;
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast': boolean; matrix: { include: Record<string, string>[] } };
  steps: Step[];
};
const root = path.resolve(__dirname, '../..');
function readYaml<T>(file: string): T {
  return yaml.load(fs.readFileSync(path.join(root, file), 'utf8')) as T;
}
const workflow = readYaml<{ jobs: Record<string, Job> }>('.github/workflows/release.yml');
const buildAction = readYaml<{ runs: { steps: Step[] } }>('.github/actions/build-release-image/action.yml');
const publishAction = readYaml<{ runs: { steps: Step[] } }>('.github/actions/publish-release-image/action.yml');
const images = [
  'agent', 'api-proxy', 'router', 'cli-proxy', 'build-tools', 'gh-aw-node',
  'enclave-script', 'enclave-agent', 'enclave-mcp-server',
];
const needs = (job: Job): string[] => typeof job.needs === 'string' ? [job.needs] : job.needs ?? [];
const nativeMatrix = {
  'fail-fast': false,
  matrix: { include: [
    { arch: 'amd64', runner: 'ubuntu-24.04' },
    { arch: 'arm64', runner: 'ubuntu-24.04-arm' },
  ] },
};
const findUse = (job: Job, action: string) => job.steps.find(step => step.uses === action)!;

describe('parallel release build contracts', () => {
  it.each(images)('builds %s natively and publishes its signed final digest exactly once', image => {
    const build = workflow.jobs[`build-${image}-platform`];
    const publish = workflow.jobs[`build-${image}`];
    expect(build['runs-on']).toBe('${{ matrix.runner }}');
    expect(build.strategy).toEqual(nativeMatrix);
    expect(needs(build)).toEqual(image === 'enclave-agent'
      ? ['bump-version', 'build-build-tools'] : ['bump-version']);
    expect(needs(publish)).toEqual(['bump-version', `build-${image}-platform`]);
    const buildStep = findUse(build, './.github/actions/build-release-image');
    const publishStep = findUse(publish, './.github/actions/publish-release-image');
    expect(buildStep.with).toMatchObject({ image, arch: '${{ matrix.arch }}', token: '${{ secrets.GITHUB_TOKEN }}' });
    expect(publishStep.with).toEqual({
      image, version: '${{ needs.bump-version.outputs.version_number }}', token: '${{ secrets.GITHUB_TOKEN }}',
    });
    expect(publish.outputs?.digest).toBe(`\${{ steps.${publishStep.id}.outputs.digest }}`);
    expect(publish.steps.filter(step => step.uses === publishStep.uses)).toHaveLength(1);
    const reference = `ghcr.io/\${{ github.repository }}/${image}@\${{ steps.${publishStep.id}.outputs.digest }}`;
    expect(publish.steps.find(step => step.run?.includes('cosign sign'))?.run).toContain(reference);
    expect(publish.steps.find(step => step.run?.includes('cosign attest'))?.run).toContain(reference);
    expect(publish.steps.find(step => step.uses?.startsWith('anchore/sbom-action@'))?.with?.image).toBe(reference);
    // Keep the pre-existing optional Rekor retry policies, not new bypasses.
    expect(publish.steps.find(step => step.run?.includes('cosign attest'))?.['continue-on-error'])
      .toBe(['build-tools', 'gh-aw-node'].includes(image) ? true : undefined);
    for (const job of [build, publish]) {
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.ref)
        .toBe('${{ needs.bump-version.outputs.version }}');
    }
    expect(workflow.jobs.release.needs).toContain(`build-${image}`);
  });

  it('uses digest-only pushes, unique artifacts and architecture-specific caches', () => {
    const build = buildAction.runs.steps.find(step => step.id === 'build')!;
    expect(build.with?.platforms).toBe('linux/${{ inputs.arch }}');
    expect(build.with?.outputs).toBe('type=image,name=ghcr.io/${{ github.repository }}/${{ inputs.image }},push-by-digest=true,name-canonical=true,push=true');
    expect(build.with?.tags).toBeUndefined();
    for (const key of ['cache-from', 'cache-to']) {
      expect(build.with?.[key]).toContain('inputs.cache');
      expect(build.with?.[key]).toContain('inputs.image, inputs.arch');
    }
    expect(buildAction.runs.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.with)
      .toEqual({
        name: '${{ inputs.image }}-digest-${{ inputs.arch }}',
        path: '${{ runner.temp }}/${{ inputs.image }}-digests/${{ inputs.arch }}',
        'if-no-files-found': 'error', 'retention-days': 1,
      });
    expect(publishAction.runs.steps.find(step => step.uses?.startsWith('actions/download-artifact@'))?.with)
      .toEqual({
        pattern: '${{ inputs.image }}-digest-*',
        path: '${{ runner.temp }}/${{ inputs.image }}-digests', 'merge-multiple': true,
      });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.steps.some(step => step.uses?.startsWith('docker/setup-qemu-action@'))).toBe(false);
    }
  });

  it('preserves build contexts, build arguments, pull and security policies', () => {
    const options = (image: string) =>
      findUse(workflow.jobs[`build-${image}-platform`], './.github/actions/build-release-image').with!;
    for (const image of images.filter(image => !image.startsWith('enclave-'))) {
      expect(options(image).context).toBe(`./containers/${image}`);
    }
    for (const image of ['agent', 'build-tools', 'gh-aw-node']) {
      expect(options(image)).toMatchObject({ 'no-cache': 'true', cache: 'false' });
    }
    for (const image of ['api-proxy', 'router']) expect(options(image).pull).toBe('true');
    for (const image of ['api-proxy', 'gh-aw-node']) {
      expect(options(image)['build-args']).toBe('AWF_VERSION=${{ needs.bump-version.outputs.version_number }}\n');
    }
    for (const image of images.filter(image => image.startsWith('enclave-'))) {
      expect(options(image)).toMatchObject({
        context: './containers', file: './containers/enclave/Dockerfile', target: image,
      });
    }
    expect(options('enclave-agent')['build-args'])
      .toBe('BUILD_TOOLS_IMAGE=ghcr.io/${{ github.repository }}/build-tools@${{ needs.build-build-tools.outputs.digest }}\n');
    expect(options('enclave-mcp-server')['build-args']).toBe('AWF_SOURCE_REVISION=${{ github.sha }}');
    expect(options('router')['build-args']).toBe(
      'VCS_REF=${{ steps.router_args.outputs.vcs_ref }}\nOPENAPI_SHA256=${{ steps.router_args.outputs.openapi_sha256 }}\n',
    );
    expect(workflow.jobs['build-router'].steps.some(step => step.name === 'Verify Router image labels and platforms'))
      .toBe(true);
    expect(options('agent')['verify-seccomp']).toBe('true');
    const verifyIndex = buildAction.runs.steps.findIndex(step => step.name === 'Verify native agent seccomp');
    const verify = buildAction.runs.steps[verifyIndex];
    expect(verify.if).toBe("inputs.verify-seccomp == 'true'");
    expect(verify.env).toMatchObject({ DIGEST: '${{ steps.build.outputs.digest }}', ARCH: '${{ inputs.arch }}' });
    expect(verify.run).toContain('"$IMAGE@$DIGEST" "linux/$ARCH"');
    expect(verifyIndex).toBeLessThan(buildAction.runs.steps.findIndex(step => step.name === 'Export image digest'));
  });

  it('fans out guest profiles with only their real dependencies and preserves architecture boundaries', () => {
    expect(needs(workflow.jobs['build-cloud-hypervisor-primary']))
      .toEqual(['bump-version', 'build-build-tools', 'build-cloud-hypervisor-guest-base']);
    expect(needs(workflow.jobs['build-cloud-hypervisor-enclave']))
      .toEqual(['bump-version', 'build-enclave-agent', 'build-cloud-hypervisor-guest-base']);
    for (const image of ['agent-act', 'cloud-hypervisor-guest-base', 'cloud-hypervisor-primary', 'cloud-hypervisor-enclave']) {
      const build = workflow.jobs[`build-${image}`].steps.find(step => step.uses?.startsWith('docker/build-push-action@'))!;
      expect(build.with?.platforms).toBe('linux/amd64');
    }
    expect(needs(workflow.jobs['build-cloud-hypervisor-test-artifacts'])).toEqual([
      'bump-version', 'build-enclave-agent', 'build-cloud-hypervisor-guest-base',
      'build-cloud-hypervisor-primary', 'build-cloud-hypervisor-enclave',
    ]);
    expect(needs(workflow.jobs['build-nvx-test-artifacts'])).toEqual(['bump-version']);
  });

  it('packages all existing binary targets and the bundle concurrently with images, before final checks', () => {
    const binaries = workflow.jobs['build-release-binaries'];
    expect(needs(binaries)).toEqual(['bump-version']);
    expect(needs(workflow.jobs['build-release-package'])).toEqual(['bump-version']);
    expect(binaries.strategy).toEqual({
      'fail-fast': false, matrix: { include: [
        { target: 'node24-linux-x64', binary: 'awf-linux-x64' },
        { target: 'node24-linux-arm64', binary: 'awf-linux-arm64' },
        { target: 'node24-macos-x64', binary: 'awf-darwin-x64' },
        { target: 'node24-macos-arm64', binary: 'awf-darwin-arm64' },
      ] },
    });
    expect(binaries.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))?.with)
      .toMatchObject({ name: 'release-binary-${{ matrix.binary }}', 'if-no-files-found': 'error' });
    const release = workflow.jobs.release;
    expect(needs(release)).toEqual(expect.arrayContaining(['build-release-package', 'build-release-binaries']));
    const steps = release.steps.map(step => step.name);
    for (const check of ['Restore binary executable permissions', 'Smoke test binary (x64)',
      'Verify arm64 binary is valid ELF', 'Verify macOS binaries are valid Mach-O',
      'Generate checksums', 'Bind release tag to checksums', 'Attest AWF release payloads and metadata',
      'Validate release asset sizes']) {
      expect(steps.indexOf(check)).toBeGreaterThan(steps.indexOf('Download release binaries'));
      expect(steps.indexOf(check)).toBeLessThan(steps.indexOf('Create GitHub Release'));
    }
    for (const job of ['enclave-conformance', 'primary-agent-validation']) {
      expect(needs(workflow.jobs[job])).toEqual(['bump-version', 'release']);
    }
  });

  it('has no dangling DAG or digest output references and every producer gates publication', () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      for (const dependency of needs(job)) expect(workflow.jobs[dependency]).toBeDefined();
      const references = JSON.stringify(job).matchAll(/needs(?:\.([\w-]+)|\['([\w-]+)'\])\.outputs\.([\w_]+)/g);
      for (const reference of references) {
        const dependency = reference[1] || reference[2];
        expect(needs(job)).toContain(dependency);
        expect(workflow.jobs[dependency].outputs?.[reference[3]]).toBeDefined();
      }
      if (name.startsWith('build-') && !name.endsWith('-platform')) {
        expect(needs(workflow.jobs.release)).toContain(name);
      }
    }
    const containers = workflow.jobs.release.steps.find(step => step.name === 'Generate containers list')!.run!;
    for (const image of images.filter(image => image !== 'build-tools')) {
      expect(containers).toContain(`/${image}@\${{ needs['build-${image}'].outputs.digest }}`);
    }
  });

  it('parses every workflow and composite shell step', () => {
    const steps = [...Object.values(workflow.jobs).flatMap(job => job.steps),
      ...buildAction.runs.steps, ...publishAction.runs.steps];
    for (const step of steps.filter(step => step.run)) {
      expect(spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' }).status).toBe(0);
    }
  });
});

describe('shared native image digest handoff', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-parallel-release-'));
  const exportScript = buildAction.runs.steps.find(step => step.name === 'Export image digest')!.run!;
  const publishScript = publishAction.runs.steps.find(step => step.id === 'manifest')!.run!;
  const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
  let sequence = 0;
  afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

  function fixture(imageName = 'agent') {
    const directory = path.join(scratch, String(sequence++));
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(args) + '\\n');
if (args[2] === 'create') process.exit(Number(process.env.CREATE_STATUS || 0));
if (process.env.INSPECT_STATUS) process.exit(Number(process.env.INSPECT_STATUS));
if (args.includes('--raw')) {
  console.log(JSON.stringify({ manifests: [
    { platform: { os: 'linux', architecture: 'amd64' } },
    ...(process.env.MISSING_ARM64 ? [] : [{ platform: { os: 'linux', architecture: 'arm64' } }]),
    { platform: { os: 'unknown', architecture: 'unknown' } }
  ] }));
} else console.log(process.env.MANIFEST_DIGEST || '${digest('c')}');
`, { mode: 0o755 });
    const output = path.join(directory, 'output');
    const log = path.join(directory, 'docker.log');
    return {
      directory,
      run(script: string, overrides: Record<string, string> = {}) {
        return spawnSync('bash', ['-e', '-c', script], {
          cwd: directory, encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
            GITHUB_OUTPUT: output, DOCKER_LOG: log, IMAGE_NAME: imageName,
            IMAGE: `ghcr.io/github/gh-aw-firewall/${imageName}`, VERSION: '1.2.3', ...overrides },
        });
      },
      output: () => fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '',
      commands: (): string[][] => fs.existsSync(log)
        ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : [],
    };
  }
  function exportBoth(f: ReturnType<typeof fixture>) {
    for (const [arch, value] of [['amd64', digest('a')], ['arm64', digest('b')]]) {
      expect(f.run(exportScript, { ARCH: arch, DIGEST: value }).status).toBe(0);
    }
  }

  it.each(images)('publishes %s tags once using both immutable platform sources', image => {
    const f = fixture(image);
    exportBoth(f);
    expect(f.run(publishScript).status).toBe(0);
    expect(f.commands()[0]).toEqual(['buildx', 'imagetools', 'create',
      '--tag', `ghcr.io/github/gh-aw-firewall/${image}:1.2.3`,
      '--tag', `ghcr.io/github/gh-aw-firewall/${image}:latest`,
      `ghcr.io/github/gh-aw-firewall/${image}@${digest('a')}`,
      `ghcr.io/github/gh-aw-firewall/${image}@${digest('b')}`]);
    expect(f.commands().filter(args => args[2] === 'create')).toHaveLength(1);
    expect(f.output()).toBe(`digest=${digest('c')}\n`);
  });

  it('rejects invalid build digests without handing them off', () => {
    const f = fixture();
    expect(f.run(exportScript, { ARCH: 'arm64', DIGEST: 'invalid' }).status).not.toBe(0);
    expect(fs.existsSync(path.join(f.directory, 'agent-digests', 'arm64'))).toBe(false);
  });

  it.each(['missing', 'invalid'])('rejects a %s platform digest before any tag publication', mode => {
    const f = fixture();
    expect(f.run(exportScript, { ARCH: 'amd64', DIGEST: digest('a') }).status).toBe(0);
    if (mode === 'invalid') fs.writeFileSync(path.join(f.directory, 'agent-digests', 'arm64'), 'invalid');
    expect(f.run(publishScript).status).not.toBe(0);
    expect(f.commands()).toEqual([]);
    expect(f.output()).toBe('');
  });

  it.each<Record<string, string>>([
    { CREATE_STATUS: '1' }, { INSPECT_STATUS: '1' },
    { MANIFEST_DIGEST: 'invalid' }, { MISSING_ARM64: '1' },
  ])('does not export a final digest when publication/verification fails: %j', overrides => {
    const f = fixture();
    exportBoth(f);
    expect(f.run(publishScript, overrides).status).not.toBe(0);
    expect(f.output()).toBe('');
  });
});
