import * as yaml from 'js-yaml';
import { gunzipSync } from 'zlib';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';

const root = path.resolve(__dirname, '../..');
const buildPath = path.join(root, 'guest/cloud-hypervisor/build-test-artifacts.sh');
const verifyPath = path.join(root, 'guest/cloud-hypervisor/verify-test-artifacts.sh');
const setupPath = path.join(root, 'guest/cloud-hypervisor/setup-enclave-artifacts.sh');
const sbomGeneratorPath = path.join(
  root,
  'guest/cloud-hypervisor/generate-enclave-rootfs-sbom.mjs',
);
const dockerfilePath = path.join(root, 'containers/enclave/Dockerfile');
const releaseWorkflowPath = path.join(root, '.github/workflows/release.yml');

function releaseStep(name: string): string {
  const workflow = yaml.load(fs.readFileSync(releaseWorkflowPath, 'utf8')) as {
    jobs: { release: { steps: Array<{ name: string; run?: string }> } };
  };
  const step = workflow.jobs.release.steps.find((entry) => entry.name === name);
  if (!step?.run) throw new Error(`Missing release step: ${name}`);
  return step.run;
}

describe('Cloud Hypervisor enclave rootfs artifacts', () => {
  it('updates and commits the guest compatibility pin with each release version', () => {
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    const update = release.split('\n').find((line) =>
      line.includes('node -e') && line.includes('artifact-compatibility.json'));
    expect(update).toBeDefined();
    expect(release).toContain(
      'git add package.json package-lock.json src/cloud-hypervisor/artifact-compatibility.json',
    );
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'awf-compatibility-'));
    try {
      fs.mkdirSync(path.join(directory, 'src/cloud-hypervisor'), { recursive: true });
      execFileSync('bash', ['-eu', '-c', `VERSION=1.2.3\n${update!}`], { cwd: directory });
      expect(JSON.parse(fs.readFileSync(
        path.join(directory, 'src/cloud-hypervisor/artifact-compatibility.json'), 'utf8',
      ))).toEqual({ releaseTag: 'v1.2.3' });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('deletes each guest build intermediate only after its last consumer', () => {
    const lines = fs.readFileSync(buildPath, 'utf8').split('\n');
    const index = (pattern: string, from = 0) => {
      const found = lines.findIndex((line, i) => i >= from && line.includes(pattern));
      expect(found).toBeGreaterThanOrEqual(0);
      return found;
    };
    const lastUse = (pattern: string, before: number) =>
      lines.slice(0, before).map((line, i) => (line.includes(pattern) ? i : -1))
        .reduce((a, b) => Math.max(a, b), -1);
    const packaging = index('--file "$OUTPUT/awf-cloud-hypervisor-test-x86_64.tar.gz"');
    const cases: [string, string[]][] = [
      ['rm -rf "$BUILD/virtiofsd-target"', ['$virtiofsd_built', '$virtiofsd_src', 'cargo-home']],
      ['sudo rm -rf "$BUILD/linux-${LINUX_VERSION}"', ['$BUILD/linux-${LINUX_VERSION}/', '$linux_tar']],
      ['sudo rm -rf "$BUILD/enclave-rootfs"', ['--rootfs-tree "$BUILD/enclave-rootfs"']],
      ['sudo rm -rf "$rootfs_tree"\n', ['-d "$rootfs_tree"']],
    ];
    for (const [removal, consumers] of cases) {
      const at = removal.endsWith('\n')
        ? lines.findIndex((line) => line === removal.trim())
        : index(removal);
      expect(at).toBeGreaterThan(0);
      expect(at).toBeLessThan(packaging);
      for (const consumer of consumers) {
        expect(lastUse(consumer, at)).toBeGreaterThanOrEqual(0);
        expect(lines.slice(at + 1).some((line) => line.includes(consumer))).toBe(false);
      }
      expect(lines[at + 1]).toMatch(/^report_disk /);
    }
    // Outputs and archive encoding are unchanged; only intermediates are removed.
    const build = lines.join('\n');
    expect(lines.slice(index('report_disk setup')).join('\n')).not.toMatch(/rm [^\n]*\$OUTPUT/);
    expect(build).not.toContain('--sparse');
    expect(build).not.toMatch(/docker (image|system) prune|docker rmi/);
    const prune = index('docker builder prune --all --force');
    expect(lines[prune - 2]).toContain('AWF_CH_PRUNE_DOCKER_BUILD_CACHE:-0}" = 1');
    expect(prune).toBeGreaterThan(index('resolve_guest_image "$ENCLAVE_IMAGE" enclave'));
  });

  it.each([
    ['test-cloud-hypervisor.yml', 'Build and verify pinned artifacts'],
    ['release.yml', 'Build and verify pinned test artifacts'],
  ])('reclaims hosted-runner disk before building guest artifacts in %s', (file, name) => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8');
    const build = workflow.indexOf(`- name: ${name}`);
    const free = workflow.lastIndexOf('- name: Free unused hosted-runner disk space', build);
    expect(free).toBeGreaterThan(0);
    expect(workflow.slice(free, build)).not.toContain('hostedtoolcache/go');
    const step = workflow.slice(build, workflow.indexOf('- name:', build + 1));
    expect(step).toContain('AWF_CH_PRUNE_DOCKER_BUILD_CACHE=1');
    expect(step).toContain('./guest/cloud-hypervisor/verify-test-artifacts.sh');
  });

  it.each([buildPath, verifyPath, setupPath])('%s passes bash syntax validation', (file) => {
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });

  it('derives both role entrypoints from one guest-base-backed enclave image', () => {
    const build = fs.readFileSync(buildPath, 'utf8');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const guest = fs.readFileSync(path.join(root, 'containers/cloud-hypervisor/Dockerfile'), 'utf8');
    for (const role of ['script', 'agent']) {
      expect(dockerfile).toContain(`AS enclave-${role}`);
      expect(guest).toContain(`run-enclave-${role}`);
      expect(build).toContain(`run-enclave-${role}`);
    }
    expect(build).toContain('enclave-rootfs.sbom.spdx.json');
    expect(build).toContain('rootfs.sbom.spdx.json');
    expect(guest).toContain('FROM ${GUEST_BASE_IMAGE} AS primary');
    expect(guest).toContain('FROM ${GUEST_BASE_IMAGE} AS enclave');
    expect(build).toContain('enclave-rootfs.ext4');
    expect(build).toContain('"guestBase": {');
    expect(build).toContain('awf-cloud-hypervisor-enclave-rootfs-x86_64.tar.gz');
    expect(build).toContain('"artifactType": "awf-cloud-hypervisor-enclave-rootfs-set"');
    expect(build).toContain('"uid": 65534');
    expect(build).toContain('"gid": 65534');
    expect(build).toContain('generate-enclave-rootfs-sbom.mjs');
    expect(build).toContain('--file "$ROOT/containers/cloud-hypervisor/Dockerfile"');
    expect(build).toContain('--target enclave-agent');
    expect(build).toContain(
      'if [[ "$ENCLAVE_IMAGE" != *@sha256:* && "$ENCLAVE_AGENT_IMAGE" == "awf-enclave-agent:local" ]]',
    );
    expect(build).toContain('docker manifest inspect --verbose "$requested_image"');
    expect(build).toContain('.Descriptor.platform.architecture == "amd64"');
    expect(build).toContain('resolved_image="${requested_image%@sha256:*}@${child_digest}"');
  });

  it('generates role SPDX from the actual package database', () => {
    const generator = fs.readFileSync(sbomGeneratorPath, 'utf8');
    expect(generator).toContain('var/lib/dpkg/status');
    expect(generator).toContain('lib/apk/db/installed');
    expect(generator).toContain("relationshipType: 'CONTAINS'");
    expect(generator).toContain("relationshipType: 'GENERATED_FROM'");
    expect(generator).toContain("checksums: [{ algorithm: 'SHA256'");
  });

  it.each([true, false])('binds the primary SBOM to its resolved image (digest-pinned: %s)', (pinned) => {
    const build = fs.readFileSync(buildPath, 'utf8');
    const configDigest = 'a'.repeat(64);
    const manifestDigest = 'b'.repeat(64);
    const image = 'ghcr.io/github/gh-aw-firewall/cloud-hypervisor-primary';
    const runtimeImage = pinned ? `${image}@sha256:${manifestDigest}` : `${image}:local`;
    const selection = build.slice(
      build.indexOf('primary_image_id=$(docker image inspect'),
      build.indexOf('guest_dockerfile_sha256='),
    );
    const invocation = build.match(
      /sudo node "\$ROOT\/guest\/cloud-hypervisor\/generate-enclave-rootfs-sbom\.mjs" \\\n  --role primary [\s\S]*?--source-date-epoch "\$SOURCE_DATE_EPOCH"/,
    );
    expect(selection).not.toBe('');
    expect(invocation).not.toBeNull();
    const args = execFileSync('bash', ['-eu', '-c', [
      `docker() { printf '%s\\n' 'sha256:${configDigest}'; }`,
      'sudo() { printf "%s\\n" "$@"; }',
      selection,
      invocation![0],
      'printf "%s\\n" "$primary_image_id"',
    ].join('\n')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        primary_runtime_image: runtimeImage,
        PRIMARY_IMAGE: pinned ? `${image}@sha256:${'c'.repeat(64)}` : runtimeImage,
        ROOT: root,
        rootfs_tree: 'rootfs',
        rootfs: 'rootfs.ext4',
        OUTPUT: '.',
        RELEASE_TAG: 'v1.2.3',
        SOURCE_DATE_EPOCH: '1767225600',
      },
    }).trim().split('\n');
    expect(args[args.indexOf('--source-image-digest') + 1])
      .toBe(pinned ? manifestDigest : configDigest);
    expect(args[args.length - 1]).toBe(`sha256:${configDigest}`);
    expect(build).toContain('"imageId": "${primary_image_id}"');
  });

  it('requires the agent networking utility in the image, exported tree, and ext4 artifact', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const agent = dockerfile.split(' AS enclave-agent\n')[1].split(' AS enclave-mcp-server')[0];
    expect(dockerfile).toContain('FROM ${BUILD_TOOLS_IMAGE} AS enclave-agent');
    const base = fs.readFileSync(path.join(root, 'containers/build-tools/Dockerfile'), 'utf8');
    expect(base).toContain('dnsutils iproute2 net-tools netcat-openbsd');
    expect(base).toContain('build-essential gcc g++ make cmake');
    expect(agent).toContain('/usr/bin/ip -Version');
    const build = fs.readFileSync(buildPath, 'utf8');
    expect(build).toContain('sudo chroot "$tree" /usr/bin/ip -Version');
    const verify = fs.readFileSync(verifyPath, 'utf8');
    expect(verify).toContain('if [ "$role" = agent ]; then');
    expect(verify).toContain("debugfs -R 'stat /usr/bin/ip'");
    expect(verify).toContain("grep -E 'Mode:[[:space:]]+0[1357][0-7][0-7]'");
    const runtime = fs.readFileSync(
      path.join(root, 'guest/microvm-supervisor/runtime_linux.go'), 'utf8',
    );
    expect(runtime).toContain('"/usr/bin/ip"');
  });

  it('uses the same-release immutable primary toolchain base and explicitly supplies local bases', () => {
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(release).toContain('needs: [bump-version, build-build-tools]');
    expect(release).toContain(
      'BUILD_TOOLS_IMAGE=ghcr.io/${{ github.repository }}/build-tools@${{ needs.build-build-tools.outputs.digest }}',
    );
    const build = fs.readFileSync(buildPath, 'utf8');
    expect(build).toContain('--build-arg "BUILD_TOOLS_IMAGE=$BUILD_TOOLS_IMAGE"');
    expect(build).toContain('sudo chroot "$tree" /usr/bin/ip -Version');
    expect(release).toContain(
      'ENCLAVE_IMAGE="ghcr.io/${{ github.repository }}/cloud-hypervisor-enclave@${{ needs.build-cloud-hypervisor-profiles.outputs.enclave_digest }}"',
    );
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).not.toContain('&& ! command -v gh');
    expect(dockerfile).toContain('gcc --version && make --version && cmake --version && gh --version');
  });

  it('builds the PR scan toolchain first and does not use a stale base after failure', () => {
    const scan = fs.readFileSync(path.join(root, '.github/workflows/supply-chain-scan.yml'), 'utf8');
    expect(scan.indexOf("('build-tools',")).toBeLessThan(scan.indexOf("('enclave-agent',"));
    expect(scan).toContain('BUILD_TOOLS_IMAGE=awf-pr-scan-build-tools:pr');
    expect(scan).toContain("if name == 'enclave-agent' and not build_tools_ready:");
    expect(scan).toMatch(/if name == 'build-tools':\n\s+build_tools_ready = True/);
  });

  it.each([13, 2294165504])('emits identical SPDX bindings for a %i-byte rootfs with bounded hashing', (size) => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'awf-sbom-'));
    try {
      const tree = path.join(directory, 'rootfs');
      fs.mkdirSync(path.join(tree, 'var/lib/dpkg'), { recursive: true });
      const packageStatus = [
        'Package: ca-certificates',
        'Status: install ok installed',
        'Architecture: all',
        'Version: 20250419',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(tree, 'var/lib/dpkg/status'), packageStatus);
      fs.symlinkSync('var/lib/dpkg/status', path.join(tree, 'status-link'));
      fs.symlinkSync('missing-target', path.join(tree, 'dangling-link'));
      const rootfs = path.join(directory, 'rootfs.ext4');
      const output = path.join(directory, 'sbom.json');
      const descriptor = fs.openSync(rootfs, 'wx', 0o600);
      try {
        fs.ftruncateSync(descriptor, size);
        fs.writeSync(descriptor, Buffer.from('rootfs fixture'), 0, 13, 0);
        if (size > 13) {
          fs.writeSync(descriptor, Buffer.from('end'), 0, 3, size - 3);
        }
      } finally {
        fs.closeSync(descriptor);
      }
      const args = [
        '--max-old-space-size=64',
        sbomGeneratorPath,
        '--role', 'enclave',
        '--rootfs-tree', tree,
        '--rootfs', rootfs,
        '--output', output,
        '--release-tag', 'v1.2.3',
        '--source-image', 'ghcr.io/github/gh-aw-firewall/enclave-agent@sha256:fixture',
        '--source-image-digest', 'a'.repeat(64),
        '--source-date-epoch', '1767225600',
      ];
      execFileSync(process.execPath, args, { timeout: 120_000 });
      const checksumCommand = process.platform === 'darwin' ? 'shasum' : 'sha256sum';
      const checksumArgs = process.platform === 'darwin' ? ['-a', '256', rootfs] : [rootfs];
      const digest = execFileSync(checksumCommand, checksumArgs, {
        encoding: 'utf8', timeout: 120_000,
      }).split(/\s/)[0];
      const spdx = JSON.parse(fs.readFileSync(output, 'utf8')) as {
        documentNamespace: string;
        packages: Array<{
          name: string;
          filesAnalyzed: boolean;
          checksums?: Array<{ algorithm: string; checksumValue: string }>;
          packageVerificationCode?: { packageVerificationCodeValue: string };
        }>;
        files: Array<{ SPDXID: string; fileName: string; checksums: Array<{ algorithm: string; checksumValue: string }> }>;
        relationships: Array<{ spdxElementId: string; relationshipType: string; relatedSpdxElement: string }>;
      };
      expect(spdx.packages.map((entry) => entry.name)).toContain('ca-certificates');
      expect(spdx.packages[0].checksums).toEqual([{ algorithm: 'SHA256', checksumValue: digest }]);
      expect(spdx.packages[0].filesAnalyzed).toBe(true);
      expect(spdx.packages.slice(1).every((entry) => entry.filesAnalyzed === false)).toBe(true);
      expect(spdx.packages.slice(1).every((entry) => entry.packageVerificationCode === undefined)).toBe(true);
      const sha1 = (contents: string) => createHash('sha1').update(contents).digest('hex');
      const expectedSha1s = [packageStatus, 'var/lib/dpkg/status', 'missing-target'].map(sha1);
      expect(spdx.packages[0].packageVerificationCode).toEqual({
        packageVerificationCodeValue: sha1(expectedSha1s.sort().join('')),
      });
      expect(spdx.files.find((file) => file.fileName === './status-link')?.checksums).toEqual([
        {
          algorithm: 'SHA256',
          checksumValue: createHash('sha256').update('var/lib/dpkg/status').digest('hex'),
        },
        { algorithm: 'SHA1', checksumValue: sha1('var/lib/dpkg/status') },
      ]);
      expect(spdx.files.length).toBeGreaterThan(0);
      for (const file of spdx.files) {
        expect(spdx.relationships).toContainEqual({
          spdxElementId: 'SPDXRef-Rootfs',
          relationshipType: 'CONTAINS',
          relatedSpdxElement: file.SPDXID,
        });
      }
      expect(spdx.documentNamespace).toBe(
        `https://github.com/github/gh-aw-firewall/cloud-hypervisor/enclave/v1.2.3/${digest}`,
      );
      expect(spdx.relationships).toContainEqual({
        spdxElementId: 'SPDXRef-Rootfs',
        relationshipType: 'GENERATED_FROM',
        relatedSpdxElement: 'SPDXRef-SourceImage',
      });
      fs.unlinkSync(rootfs);
      fs.unlinkSync(output);
      const missing = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('ENOENT');
      expect(fs.existsSync(output)).toBe(false);
      fs.mkdirSync(rootfs);
      const directoryInput = spawnSync(process.execPath, args, { encoding: 'utf8' });
      expect(directoryInput.status).not.toBe(0);
      expect(directoryInput.stderr).toContain('EISDIR');
      expect(fs.existsSync(output)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);

  it('hardens both role trees before creating immutable ext4 images', () => {
    const build = fs.readFileSync(buildPath, 'utf8');
    expect(build).toContain('sudo find "$tree" -xdev -type f -perm /6000 -exec chmod a-s');
    expect(build).toContain('sudo getcap -r "$tree"');
    expect(build).toContain('"$tree/sbin/apk"');
    expect(build).toContain('"$tree/usr/bin/apt"');
    expect(build).toContain('"$tree/usr/bin/dpkg"');
    expect(build).toContain('-name npm -o -name npx -o -name corepack');
    expect(build).toContain('-name rpm -o -name dnf -o -name yum');
    expect(build).toContain("test -z \"$(sudo find \"$tree/awf/seed\" -mindepth 1 -print -quit)\"");
    expect(build).toContain('sudo chmod 01777 "$tree/tmp"');
    expect(build).toContain('sudo chown -R 0:0 "$tree"');
    expect(build).toContain('"$tree/proc" "$tree/sys" -mindepth 1');
    expect(build).toContain('"$tree/dev" -mindepth 1 ! -path "$tree/dev/shm"');
  });

  it('verifies role, size, digest, compatibility, entrypoint, and forbidden paths', () => {
    const verify = fs.readFileSync(verifyPath, 'utf8');
    for (const field of [
      '.compatibility.cloudHypervisorVersion',
      '.compatibility.kernelVersion',
      '.sizeBytes',
      '.sha256',
      '.uid',
      '.gid',
      '.entrypoint',
      '.sourceImageDigest',
      '.sbom.sha256',
    ]) {
      expect(verify).toContain(field);
    }
    expect(verify).toContain('forbidden enclave rootfs path present');
    for (const forbidden of [
      '/usr/bin/apt',
      '/usr/bin/apt-cache',
      '/usr/bin/apt-get',
      '/usr/bin/apt-mark',
      '/usr/bin/dpkg',
      '/usr/bin/dpkg-deb',
      '/usr/bin/dpkg-query',
      '/usr/bin/corepack',
      '/usr/bin/yarn',
      '/usr/bin/pnpm',
    ]) {
      expect(verify).toContain(forbidden);
    }
    expect(verify).toContain('embedded repository seed found');
    expect(verify).toContain('NF < 7 || ($6 != "." && $6 != "..")');
    expect(verify).toContain(
      'printf \'%s\\n\' "$seed_listing" | debugfs_listing_has_non_dot_entries',
    );
  });

  it('accepts only dot entries in hardened debugfs directory listings', () => {
    const validator = 'NF > 0 && (NF < 7 || ($6 != "." && $6 != "..")) '
      + '{ print; found=1 } END { exit found ? 0 : 1 }';
    const emptyDirectory = [
      '/678/040555/0/0/./0/',
      '/2518/040755/0/0/../0/',
    ].join('\n');
    expect(() => execFileSync('awk', ['-F/', validator], {
      input: `${emptyDirectory}\n`,
    })).toThrow();

    const embeddedDevice = `${emptyDirectory}\n/3000/020666/0/0/null/0/\n`;
    expect(execFileSync('awk', ['-F/', validator], {
      input: embeddedDevice,
      encoding: 'utf8',
    })).toContain('/null/');

    expect(execFileSync('awk', ['-F/', validator], {
      input: 'malformed debugfs output\n',
      encoding: 'utf8',
    })).toContain('malformed debugfs output');
  });

  it('downloads once and re-verifies attestation, metadata, digest, and size on cache reuse', () => {
    const setup = fs.readFileSync(setupPath, 'utf8');
    expect(setup).toContain('if [ -e "$cache_dir" ]');
    expect(setup).toContain('verify_cache "$cache_dir"');
    expect(setup).toContain('refusing to reuse or replace it');
    expect(setup).toContain('gh release download "$RELEASE_TAG"');
    expect(setup.match(/gh attestation verify/g)).toHaveLength(1);
    expect(setup).toContain('--signer-workflow "$SIGNER_WORKFLOW"');
    expect(setup).toContain('--deny-self-hosted-runners');
    expect(setup).toContain('.compatibility.supervisorVersion');
    expect(setup).toContain('.sourceImageDigest | test');
    expect(setup).toContain("'repository,workflow,tag,sourceCommit'");
    expect(setup).toContain('enclave-*rootfs.provenance.sigstore.jsonl');
    expect(setup).toContain('AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS');
    expect(setup).toContain('AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS');
  });

  it('publishes one shared enclave image and rootfs without replacing OCI enclave images', () => {
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(release).toContain(
      'GUEST_BASE_IMAGE="ghcr.io/${{ github.repository }}/cloud-hypervisor-guest-base@${{ needs.build-cloud-hypervisor-guest-base.outputs.digest }}"',
    );
    expect(release).toContain(
      'subject-path: release/cloud-hypervisor-test-x86_64/enclave-rootfs.ext4',
    );
    expect(release).toContain('release/enclave-rootfs.provenance.sigstore.jsonl');
    expect(release).toContain('release/enclave-rootfs.sbom.spdx.json');
    expect(release).toContain('release/cloud-hypervisor-rootfs.sbom.spdx.json');
    for (const role of ['script', 'agent']) {
      expect(release).toContain(
        `ghcr.io/\${{ github.repository }}/enclave-${role}@\${{ steps.build_enclave_${role}.outputs.digest }}`,
      );
    }
    expect(release).toContain(
      'subject-path: release/cloud-hypervisor-test-x86_64/enclave-manifest.json',
    );
    expect(release).toContain(
      'release/cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl',
    );
    expect(release).toContain('release/setup-cloud-hypervisor-enclave-artifacts.sh');
  });

  it('signs and attests SPDX SBOMs for every Cloud Hypervisor guest image digest', () => {
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    for (const image of [
      'cloud-hypervisor-guest-base',
      'cloud-hypervisor-primary',
      'cloud-hypervisor-enclave',
    ]) {
      expect(release).toContain(`ghcr.io/\${{ github.repository }}/${image}@\${{ steps.build_${image === 'cloud-hypervisor-guest-base' ? 'guest_base' : image === 'cloud-hypervisor-primary' ? 'primary' : 'enclave'}.outputs.digest }}`);
      expect(release).toContain(`--predicate ${image}-sbom.spdx.json`);
      expect(release).toContain(`--type spdxjson`);
    }
  });

  it('stages compressed rootfs assets without changing their attested contents', () => {
    const stage = releaseStep('Stage Cloud Hypervisor preview test assets');
    expect(stage).toContain('gzip -n -c');
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'awf-release-'));
    try {
      const source = path.join(directory, 'cloud-hypervisor-release-assets');
      fs.mkdirSync(source);
      fs.mkdirSync(path.join(directory, 'release'));
      for (const match of stage.matchAll(/cloud-hypervisor-release-assets\/([\w.-]+)/g)) {
        fs.writeFileSync(path.join(source, match[1]), `fixture: ${match[1]}`);
      }
      execFileSync('bash', ['-euo', 'pipefail', '-c', stage], { cwd: directory });
      const name = 'enclave-rootfs.ext4';
      expect(fs.existsSync(path.join(directory, 'release', name))).toBe(false);
      expect(gunzipSync(fs.readFileSync(path.join(directory, 'release', `${name}.gz`))))
        .toEqual(fs.readFileSync(path.join(source, name)));
      const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
      expect(release).toMatch(/^\s+release\/enclave-rootfs\.ext4\.gz$/m);
      expect(release).not.toMatch(/^\s+release\/enclave-(agent|script)-rootfs\.ext4$/m);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects release assets at or above the upload limit before creating the release', () => {
    const check = releaseStep('Validate release asset sizes');
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(release.indexOf('name: Validate release asset sizes'))
      .toBeLessThan(release.indexOf('name: Create GitHub Release'));
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'awf-size-'));
    try {
      fs.mkdirSync(path.join(directory, 'release'));
      const asset = path.join(directory, 'release', 'fixture.ext4.gz');
      const fd = fs.openSync(asset, 'w');
      try {
        fs.ftruncateSync(fd, 2147483647);
        expect(() => execFileSync('bash', ['-euo', 'pipefail', '-c', check], {
          cwd: directory, stdio: 'pipe',
        })).not.toThrow();
        for (const size of [2147483648, 2147483649, 2319572992]) {
          fs.ftruncateSync(fd, size);
          expect(() => execFileSync('bash', ['-euo', 'pipefail', '-c', check], {
            cwd: directory, stdio: 'pipe',
          })).toThrow(/fixture\.ext4\.gz.*must be less than 2147483648/);
        }
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
