import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const root = path.resolve(__dirname, '../..');
const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
type Step = { name: string; run?: string; uses?: string; with?: Record<string, unknown> };
const action = yaml.load(fs.readFileSync(path.join(root, 'action.yml'), 'utf8')) as {
  runs: { steps: Step[] };
};
const installAction = action.runs.steps.find(step => step.name === 'Install awf')!.run!;
const pullAction = action.runs.steps.find(step => step.name === 'Pull Docker images')!.run!;
const scratch = path.join(root, `.bootstrap-provenance-tests-${process.pid}`);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const tag = 'v1.2.3';
const images = [
  'squid', 'agent', 'agent-act', 'api-proxy', 'router', 'cli-proxy',
  'enclave-script', 'enclave-agent', 'enclave-mcp-server',
];
let sequence = 0;

function fixture(options: { bundle?: boolean; identityTag?: string; containers?: string; helper?: boolean } = {}) {
  const directory = path.join(scratch, String(sequence++));
  const bin = path.join(directory, 'bin');
  const assets = path.join(directory, 'assets');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(assets);
  fs.mkdirSync(path.join(directory, 'installed'));
  const payload = options.bundle ? '#!/usr/bin/env node\nconsole.log("awf");\n' : 'test ELF payload\n';
  const helper = fs.readFileSync(path.join(root, 'scripts/enclave-storage-helper.py'), 'utf8')
    .replace(/^VERSION = "[^"]+"$/m, 'VERSION = "1.2.3"');
  const containers = options.containers ??
    images.map(image => `ghcr.io/github/gh-aw-firewall/${image}@sha256:${'a'.repeat(64)}\n`).join('');
  const checksums = [
    `${hash(payload)}  awf-linux-x64`,
    `${hash(payload)}  awf-bundle.js`,
    `${hash(containers)}  containers.txt`,
    ...(options.helper === false ? [] : [`${hash(helper)}  enclave-storage-helper.py`]),
    '',
  ].join('\n');
  for (const [name, content] of Object.entries({
    'awf-linux-x64': payload,
    'awf-bundle.js': payload,
    'checksums.txt': checksums,
    'containers.txt': containers,
    ...(options.helper === false ? {} : { 'enclave-storage-helper.py': helper }),
    'release-identity.txt': `${hash(checksums)}  refs/tags/${options.identityTag ?? tag}\n`,
  })) fs.writeFileSync(path.join(assets, name), content);
  const scripts = {
    gh: `#!/bin/bash
if [ "$3" = "--help" ]; then
  [ "\${GH_NO_SUPPORT:-}" != "1" ] || exit 1
  if [ "\${GH_MISSING_FLAG:-}" != "1" ]; then
    echo "--signer-workflow --deny-self-hosted-runners"
  fi
  if [ "\${GH_LARGE_HELP:-}" = "1" ]; then
    # Exceed the pipe buffer so an early-exiting reader reliably breaks the writer.
    set -e
    for ((i = 0; i < 16384; i++)); do
      printf '%s\\n' 'Additional attestation verify help text'
    done
  fi
  exit "\${GH_HELP_STATUS:-0}"
fi
printf '%s\\n' "$*" >> "$CASE_DIR/gh.log"
[ "$1 $2" = "attestation verify" ] || exit 51
[[ "$*" == *"--hostname github.com"* ]] || exit 52
[[ "$*" == *"--repo github/gh-aw-firewall"* ]] || exit 53
[[ "$*" == *"--signer-workflow github/gh-aw-firewall/.github/workflows/release.yml"* ]] || exit 54
[[ "$*" == *"--cert-oidc-issuer https://token.actions.githubusercontent.com"* ]] || exit 55
[[ "$*" == *"--deny-self-hosted-runners"* ]] || exit 56
if [ -n "\${FAIL_ATTESTATION:-}" ] && [[ "$3" == *"$FAIL_ATTESTATION"* ]]; then exit 57; fi
`,
    curl: `#!/bin/bash
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
asset="\${url##*/}"
printf '%s\\n' "$asset" >> "$CASE_DIR/curl.log"
if [ "$asset" = latest ]; then printf '{"tag_name": "%s"}\\n' "\${LATEST_TAG:-v1.2.3}"; exit; fi
cp "$CASE_DIR/assets/$asset" "$output"
`,
    file: '#!/bin/bash\necho "$1: ELF 64-bit LSB executable"\n',
    uname: '#!/bin/bash\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
    docker: '#!/bin/bash\nprintf "%s\\n" "$*" >> "$CASE_DIR/docker.log"\nexit "${DOCKER_STATUS:-0}"\n',
    node: '#!/bin/bash\necho v22.0.0\n',
    'helper-installer': `#!/bin/bash
cat > "$CASE_DIR/helper-install-body"
printf '%s\\n' "$*" >> "$CASE_DIR/helper-install.log"
grep -q 'VERSION = "1.2.3"' "$1"
`,
    'helper-host-check': `#!/bin/bash
printf "%s" "\${GH_TOKEN+x}" > ${JSON.stringify(path.join(directory, 'helper-host-check-token'))}
[ ! -e ${JSON.stringify(path.join(directory, 'unsupported-storage-host'))} ] || exit 1
`,
  };
  for (const [name, script] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(bin, name), script, { mode: 0o755 });
  }
  return {
    directory,
    assets,
    run(target: 'installer' | 'action' | 'pull', overrides: Record<string, string> = {}) {
      if (overrides.UNSUPPORTED_STORAGE_HOST) {
        fs.writeFileSync(path.join(directory, 'unsupported-storage-host'), '');
      }
      const script = target === 'installer'
        ? installer.replace(/\nmain "\$@"\s*$/, '\n')
          .replace('TEMP_DIR=$(mktemp -d -t awf-install.XXXXXX)',
            'TEMP_DIR="$CASE_DIR/downloads"; mkdir "$TEMP_DIR"')
          .replace('/usr/bin/python3 -I - "$TEMP_DIR/$helper" "${VERSION#v}" "${SUDO_UID:-}"',
            '"$CASE_DIR/bin/helper-installer" "$TEMP_DIR/$helper" "${VERSION#v}" "${SUDO_UID:-}"')
          .replace('/usr/bin/python3 -I "$TEMP_DIR/$helper" check-install-host',
            '"$CASE_DIR/bin/helper-host-check" "$TEMP_DIR/$helper"') +
          '\ncheck_sudo() { :; }\n' +
          // Keep all test artifacts in this project's scratch directory, never the OS temp area.
          'INSTALL_DIR="$CASE_DIR/installed"\nmain "$INPUT_VERSION"\n'
        : target === 'action' ? installAction : pullAction;
      return spawnSync('bash', ['-c', script], {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CASE_DIR: directory,
          AWF_VERSION: '',
          AWF_FORCE_BINARY: options.bundle ? '' : '1',
          INPUT_VERSION: tag,
          GITHUB_TOKEN: '',
          RUNNER_TEMP: directory,
          GITHUB_OUTPUT: path.join(directory, 'output'),
          GITHUB_PATH: path.join(directory, 'github-path'),
          ...overrides,
        },
      });
    },
    log(name: string) {
      const file = path.join(directory, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    },
  };
}

afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

describe('release bootstrap authentication', () => {
  it('validates the isolated signed fixtures used by composite-action CI', () => {
    execFileSync(process.execPath, ['--test', 'scripts/ci/action-fixture-smoke.cjs'], { cwd: root, stdio: 'pipe' });
  }, 30000);

  it('isolates action fixtures from the optional live attested-release test', () => {
    const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/test-action.yml'), 'utf8')) as {
      jobs: Record<string, { if?: string; steps: Step[] }>;
    };
    for (const name of ['test-action-latest', 'test-action-specific-version', 'test-action-with-images']) {
      const steps = workflow.jobs[name].steps;
      const prepare = steps.findIndex(step => step.run === 'node scripts/ci/setup-action-test-fixtures.cjs');
      const install = steps.findIndex(step => step.uses === './');
      expect(prepare).toBeGreaterThanOrEqual(0);
      expect(prepare).toBeLessThan(install);
      expect(steps[install].with?.version).toBe(name === 'test-action-latest' ? undefined : tag);
      expect(steps.some(step => step.run?.includes('verified.log'))).toBe(true);
    }
    const live = workflow.jobs['test-action-live-attested-release'];
    expect(live.if).toContain("github.event_name == 'workflow_dispatch'");
    expect(live.steps.some(step => step.run?.includes('setup-action-test-fixtures'))).toBe(false);
    expect(live.steps.find(step => step.uses === './')?.with?.['pull-images']).toBe('true');
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps.filter(step => step.run)) {
        expect(spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' }).status).toBe(0);
      }
    }
  });

  it.each(['installer', 'action'] as const)('installs an authenticated %s payload', target => {
    const f = fixture();
    const result = f.run(target, target === 'installer' ? { GH_TOKEN: 'present' } : {});
    expect(result.stderr + result.stdout).not.toContain('::error::');
    expect(result.status).toBe(0);
    const destination = path.join(f.directory, target === 'installer' ? 'installed/awf' : 'awf-bin/awf');
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const installed = fs.fstatSync(fd);
      expect(installed.isFile() && (installed.mode & 0o111) !== 0).toBe(true);
      expect(fs.readFileSync(fd, 'utf8')).toBe('test ELF payload\n');
    } finally {
      fs.closeSync(fd);
    }
    const calls = f.log('gh.log').trim().split('\n');
    expect(calls[0]).toContain('release-identity.txt');
    expect(calls[1]).toContain('checksums.txt');
    expect(calls[2]).toContain('awf-linux-x64');
    if (target === 'action') {
      expect(calls[3]).toContain('containers.txt');
      expect(f.log('output')).toContain(`squid=sha256:${'a'.repeat(64)}`);
    } else {
      expect(calls[3]).toContain('enclave-storage-helper.py');
      expect(f.log('helper-install.log')).toContain('1.2.3');
      expect(f.log('helper-host-check-token')).toBe('');
    }
  });

  it('authenticates the lightweight bundle before installation', () => {
    const f = fixture({ bundle: true });
    expect(f.run('installer').status).toBe(0);
    expect(f.log('gh.log')).toContain('awf-bundle.js');
  });

  it('authenticates the helper before privileged installation or publishing AWF', () => {
    const f = fixture();
    expect(f.run('installer', { FAIL_ATTESTATION: 'enclave-storage-helper.py' }).status).not.toBe(0);
    expect(f.log('helper-install.log')).toBe('');
    expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(false);
  });

  it('rejects helper checksum substitution before privileged installation', () => {
    const f = fixture();
    fs.appendFileSync(path.join(f.assets, 'enclave-storage-helper.py'), '# changed\n');
    const result = f.run('installer');
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain('Checksum verification failed');
    expect(f.log('helper-install.log')).toBe('');
    expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(false);
  });

  it('preserves authenticated legacy CLI installs without advertising helper support', () => {
    const f = fixture({ helper: false });
    const result = f.run('installer');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('no unprivileged Docker enclave support');
    expect(f.log('curl.log')).not.toContain('enclave-storage-helper.py');
    expect(f.log('helper-install.log')).toBe('');
    expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(true);
  });

  it('fails closed when the signed manifest lists an unavailable helper', () => {
    const f = fixture();
    fs.unlinkSync(path.join(f.assets, 'enclave-storage-helper.py'));
    const result = f.run('installer');
    expect(result.status).not.toBe(0);
    expect(f.log('helper-install.log')).toBe('');
    expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(false);
  });

  it('preserves ordinary CLI installs on unsupported storage hosts only after authenticating the helper', () => {
    const f = fixture();
    const result = f.run('installer', { UNSUPPORTED_STORAGE_HOST: '1' });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('not a supported privileged storage host');
    expect(f.log('gh.log')).toContain('enclave-storage-helper.py');
    expect(f.log('helper-install.log')).toBe('');
    expect(fs.readFileSync(path.join(f.directory, 'installed/awf'), 'utf8')).toBe('test ELF payload\n');
    const bad = fixture();
    expect(bad.run('installer', {
      UNSUPPORTED_STORAGE_HOST: '1', FAIL_ATTESTATION: 'enclave-storage-helper.py',
    }).status).not.toBe(0);
  });

  it('packages, attests and uploads the version-matched narrow helper', () => {
    const release = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
      jobs: Record<string, { steps: Step[] }>;
    };
    const steps = Object.values(release.jobs).flatMap(job => job.steps || []);
    const packageStep = steps.find(step => step.name === 'Package host enclave storage helper')!;
    expect(packageStep.run).toBe('node scripts/build-enclave-storage-helper.mjs');
    const attest = steps.find(step => step.name === 'Attest AWF release payloads and metadata')!;
    expect(attest.with?.['subject-path']).toContain('release/enclave-storage-helper.py');
    expect(steps.some(step => String(step.with?.files || '').includes('release/enclave-storage-helper.py'))).toBe(true);
    expect(installer).toContain('/var/lib/awf/enclave-storage-helper.py *');
    expect(installer).toContain('os.O_NOFOLLOW');
    expect(installer).toContain('"/usr/sbin/visudo", "-cf"');
  });

  it('accepts supported gh help larger than the pipe buffer under pipefail', () => {
    const f = fixture();
    const result = f.run('action', { GH_LARGE_HELP: '1' });
    expect(result.stderr + result.stdout).not.toContain('::error::');
    expect(result.status).toBe(0);
    expect(f.log('gh.log')).toContain('awf-linux-x64');
  });

  it.each<Record<string, string>>([
    { GH_MISSING_FLAG: '1' },
    { GH_HELP_STATUS: '1' },
  ])('rejects unsupported or failed gh help before downloading: %j', overrides => {
    const f = fixture();
    const result = f.run('action', overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/trusted gh CLI/);
    expect(f.log('curl.log')).toBe('');
  });

  it('rejects an unattested lightweight bundle', () => {
    const f = fixture({ bundle: true });
    expect(f.run('installer', { FAIL_ATTESTATION: 'awf-bundle.js' }).status).not.toBe(0);
    expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(false);
  });

  for (const target of ['installer', 'action'] as const) {
    it(`${target} requires a trusted, attestation-capable verifier before any download`, () => {
      const f = fixture();
      const result = f.run(target, { GH_NO_SUPPORT: '1' });
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/trusted gh CLI/);
      expect(f.log('curl.log')).toBe('');
    });

    it.each(['release-identity.txt', 'checksums.txt', 'awf-linux-x64'])(
      `${target} rejects failed provenance for %s`,
      asset => {
        const f = fixture();
        const result = f.run(target, { FAIL_ATTESTATION: asset });
        expect(result.status).not.toBe(0);
        expect(result.stderr + result.stdout).toMatch(/attested release/i);
        expect(f.log('github-path')).toBe('');
        expect(fs.existsSync(path.join(f.directory, 'installed/awf'))).toBe(false);
        expect(fs.existsSync(path.join(f.directory, 'awf-bin/awf'))).toBe(false);
      },
    );

    it(`${target} rejects another release's signed identity`, () => {
      const f = fixture({ identityTag: 'v9.9.9' });
      expect(f.run(target).status).not.toBe(0);
      expect(f.log('gh.log').trim().split('\n')).toHaveLength(1);
    });

    it(`${target} rejects same-channel substitution of payload and checksums`, () => {
      const f = fixture();
      const payload = 'attacker controlled executable';
      fs.writeFileSync(path.join(f.assets, 'awf-linux-x64'), payload);
      fs.writeFileSync(path.join(f.assets, 'checksums.txt'), `${hash(payload)}  awf-linux-x64\n`);
      const result = f.run(target);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('Release identity does not bind');
    });

    it(`${target} retains checksum validation in addition to provenance`, () => {
      const f = fixture();
      fs.appendFileSync(path.join(f.assets, 'awf-linux-x64'), 'changed\n');
      const result = f.run(target);
      expect(result.status).not.toBe(0);
      expect(result.stderr + result.stdout).toContain('Checksum verification failed');
    });

    it(`${target} fails closed for legacy releases missing identity metadata`, () => {
      const f = fixture();
      fs.unlinkSync(path.join(f.assets, 'release-identity.txt'));
      expect(f.run(target).status).not.toBe(0);
      expect(f.log('gh.log')).toBe('');
    });

    it(`${target} validates a latest API response before downloading assets`, () => {
      const f = fixture();
      expect(f.run(target, { INPUT_VERSION: target === 'installer' ? '' : 'latest', LATEST_TAG: '../bad' }).status).not.toBe(0);
      expect(f.log('curl.log').trim()).toBe('latest');
    });
  }

  it.each(['missing', 'unattested', 'substituted', 'duplicate', 'incomplete'])(
    'rejects a %s container manifest without tag fallback',
    failure => {
      const containers = `ghcr.io/github/gh-aw-firewall/squid@sha256:${'a'.repeat(64)}\n`;
      const f = fixture(failure === 'duplicate' ? { containers: containers.repeat(2) } :
        failure === 'incomplete' ? { containers } : {});
      if (failure === 'missing') fs.unlinkSync(path.join(f.assets, 'containers.txt'));
      if (failure === 'substituted') fs.appendFileSync(path.join(f.assets, 'containers.txt'), 'changed\n');
      const result = f.run('action', failure === 'unattested' ? { FAIL_ATTESTATION: 'containers.txt' } : {});
      expect(result.status).not.toBe(0);
      expect(f.log('output')).not.toContain('image_tag=');
      expect(f.log('github-path')).toBe('');
    },
  );

  it('pulls only authenticated digest-pinned images and does not retry latest on failure', () => {
    const f = fixture();
    const imageTag = `${tag.slice(1)},squid=sha256:${'a'.repeat(64)},agent=sha256:${'b'.repeat(64)}`;
    expect(f.run('pull', { IMAGE_TAG: imageTag }).status).toBe(0);
    expect(f.log('docker.log')).toBe(
      `pull ghcr.io/github/gh-aw-firewall/squid@sha256:${'a'.repeat(64)}\n` +
      `pull ghcr.io/github/gh-aw-firewall/agent@sha256:${'b'.repeat(64)}\n`,
    );
    const failed = fixture();
    expect(failed.run('pull', { IMAGE_TAG: imageTag, DOCKER_STATUS: '1' }).status).not.toBe(0);
    expect(failed.log('docker.log').trim().split('\n')).toHaveLength(1);
    expect(failed.log('docker.log')).not.toContain('latest');
  });
});

describe('release provenance publication', () => {
  const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8')) as {
    permissions: Record<string, string>;
    jobs: Record<string, { steps: Step[] }>;
  };
  const steps = workflow.jobs.release.steps;

  it('attests every bootstrap subject after generation and before publication', () => {
    const attest = steps.findIndex(step => step.name === 'Attest AWF release payloads and metadata');
    const identity = steps.findIndex(step => step.name === 'Bind release tag to checksums');
    const checksums = steps.findIndex(step => step.name === 'Generate checksums');
    const publish = steps.findIndex(step => step.name === 'Create GitHub Release');
    expect(workflow.permissions.attestations).toBe('write');
    expect(checksums).toBeLessThan(identity);
    expect(identity).toBeLessThan(attest);
    expect(attest).toBeLessThan(publish);
    expect(steps[attest].uses).toBe(
      'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8',
    );
    for (const asset of [
      'awf-linux-x64', 'awf-linux-arm64', 'awf-darwin-x64', 'awf-darwin-arm64',
      'awf-bundle.js', 'awf.tgz', 'checksums.txt', 'containers.txt', 'release-identity.txt',
    ]) {
      expect(steps[attest].with?.['subject-path']).toContain(`release/${asset}\n`);
      expect(steps[publish].with?.files).toContain(`release/${asset}\n`);
    }
    expect(steps[identity].run).toContain('refs/tags/${RELEASE_TAG}^{commit}');
    expect(steps[identity].run).toContain('sha256sum release/checksums.txt');
    expect(steps[identity].run).toContain('refs/tags/%s');
  });
});
