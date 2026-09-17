import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

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

describe('Cloud Hypervisor enclave rootfs artifacts', () => {
  it.each([buildPath, verifyPath, setupPath])('%s passes bash syntax validation', (file) => {
    expect(() => execFileSync('bash', ['-n', file])).not.toThrow();
  });

  it('derives distinct role rootfs images from the audited enclave container stages', () => {
    const build = fs.readFileSync(buildPath, 'utf8');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    for (const role of ['script', 'agent']) {
      expect(dockerfile).toContain(`AS enclave-${role}`);
      expect(build).toContain(`enclave-${role}`);
      expect(build).toContain(`enclave-${role}-rootfs.ext4`);
      expect(build).toContain(`enclave-${role}-rootfs.sbom.spdx.json`);
    }
    expect(build).toContain('awf-cloud-hypervisor-enclave-rootfs-x86_64.tar.gz');
    expect(build).toContain('"artifactType": "awf-cloud-hypervisor-enclave-rootfs-set"');
    expect(build).toContain('"uid": 65534');
    expect(build).toContain('"gid": 65534');
    expect(build).toContain('generate-enclave-rootfs-sbom.mjs');
    expect(build).toContain('--file "$ROOT/containers/enclave/Dockerfile"');
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

  it('emits installed packages and the rootfs checksum in generated SPDX', () => {
    const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'awf-sbom-'));
    try {
      const tree = path.join(directory, 'rootfs');
      fs.mkdirSync(path.join(tree, 'var/lib/dpkg'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'var/lib/dpkg/status'), [
        'Package: ca-certificates',
        'Status: install ok installed',
        'Architecture: all',
        'Version: 20250419',
        '',
      ].join('\n'));
      const rootfs = path.join(directory, 'rootfs.ext4');
      const output = path.join(directory, 'sbom.json');
      fs.writeFileSync(rootfs, 'rootfs fixture');
      execFileSync(process.execPath, [
        sbomGeneratorPath,
        '--role', 'agent',
        '--rootfs-tree', tree,
        '--rootfs', rootfs,
        '--output', output,
        '--release-tag', 'v1.2.3',
        '--source-image', 'ghcr.io/github/gh-aw-firewall/enclave-agent@sha256:fixture',
        '--source-image-digest', 'a'.repeat(64),
        '--source-date-epoch', '1767225600',
      ]);
      const spdx = JSON.parse(fs.readFileSync(output, 'utf8')) as {
        packages: Array<{ name: string; checksums?: Array<{ checksumValue: string }> }>;
      };
      expect(spdx.packages.map((entry) => entry.name)).toContain('ca-certificates');
      expect(spdx.packages[0].checksums?.[0].checksumValue).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('hardens both role trees before creating immutable ext4 images', () => {
    const build = fs.readFileSync(buildPath, 'utf8');
    expect(build).toContain('sudo find "$tree" -xdev -type f -perm /6000 -exec chmod a-s');
    expect(build).toContain('sudo getcap -r "$tree"');
    expect(build).toContain('"$tree/sbin/apk"');
    expect(build).toContain('"$tree/usr/bin/apt"');
    expect(build).toContain('"$tree/usr/bin/dpkg"');
    expect(build).toContain("test -z \"$(sudo find \"$tree/awf/seed\" -mindepth 1 -print -quit)\"");
    expect(build).toContain('sudo chmod 01777 "$tree/tmp"');
    expect(build).toContain('sudo chown -R 0:0 "$tree"');
    expect(build).toContain('"$tree/dev" "$tree/proc" "$tree/sys" -mindepth 1');
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
    expect(setup).toContain('enclave-script-rootfs.provenance.sigstore.jsonl');
    expect(setup).toContain('enclave-agent-rootfs.provenance.sigstore.jsonl');
    expect(setup).toContain('AWF_CLOUD_HYPERVISOR_ENCLAVE_SCRIPT_ROOTFS');
    expect(setup).toContain('AWF_CLOUD_HYPERVISOR_ENCLAVE_AGENT_ROOTFS');
  });

  it('publishes and independently attests each role artifact without replacing container images', () => {
    const release = fs.readFileSync(releaseWorkflowPath, 'utf8');
    expect(release).toContain(
      'ENCLAVE_SCRIPT_IMAGE="ghcr.io/${{ github.repository }}/enclave-script@${{ needs.build-enclaves.outputs.enclave_script_digest }}"',
    );
    expect(release).toContain(
      'ENCLAVE_AGENT_IMAGE="ghcr.io/${{ github.repository }}/enclave-agent@${{ needs.build-enclaves.outputs.enclave_agent_digest }}"',
    );
    for (const role of ['script', 'agent']) {
      expect(release).toContain(
        `subject-path: release/cloud-hypervisor-test-x86_64/enclave-${role}-rootfs.ext4`,
      );
      expect(release).toContain(`release/enclave-${role}-rootfs.ext4`);
      expect(release).toContain(`release/enclave-${role}-rootfs.sbom.spdx.json`);
      expect(release).toContain(
        `release/enclave-${role}-rootfs.provenance.sigstore.jsonl`,
      );
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
});
