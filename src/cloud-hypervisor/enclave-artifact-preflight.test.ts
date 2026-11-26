import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as artifactTrust from './artifact-trust';
import { preflightCloudHypervisorEnclaveArtifacts } from './enclave-artifact-preflight';
import {
  HostPreflightReporter, markHostPreflightError, type HostPreflightCheck,
} from './host-preflight-progress';

describe('Enclave artifact preflight stage boundaries', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awf-enclave-preflight-stages-'));
    jest.spyOn(artifactTrust, 'resolveTrustedOperatorUid').mockReturnValue(process.getuid!());
    jest.spyOn(artifactTrust, 'assertTrustedHostTool').mockResolvedValue();
    jest.spyOn(artifactTrust, 'assertTrustedRegularFile').mockResolvedValue();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it.each<HostPreflightCheck>([
    'operator-identity', 'tool-gh', 'manifest-bundle-path', 'manifest-trust', 'bundle-trust',
    'manifest-read', 'bundle-read', 'verification-directory', 'manifest-parse',
  ])('stops at %s without executing later stages', async (failedCheck) => {
    const options = {
      releaseTag: 'invalid-release',
      manifestPath: path.join(directory, 'manifest.json'),
      manifestBundlePath: path.join(directory, 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.sigstore.jsonl'),
      attestationToolPath: '/trusted/gh',
    };
    await fs.writeFile(options.manifestPath, Buffer.from([0xff]), { mode: 0o400 });
    await fs.writeFile(options.manifestBundlePath, '{}', { mode: 0o400 });
    const failure = markHostPreflightError(new Error('PRIVATE_SENTINEL'), 'requirement-not-met');
    if (failedCheck === 'operator-identity') {
      jest.mocked(artifactTrust.resolveTrustedOperatorUid).mockImplementation(() => { throw failure; });
    } else if (failedCheck === 'tool-gh') {
      jest.mocked(artifactTrust.assertTrustedHostTool).mockRejectedValue(failure);
    } else if (failedCheck === 'manifest-bundle-path') {
      options.manifestBundlePath = path.join(directory, 'wrong-bundle');
    } else if (failedCheck === 'manifest-trust' || failedCheck === 'bundle-trust') {
      jest.mocked(artifactTrust.assertTrustedRegularFile).mockImplementation(async (_label, file) => {
        if (file === (failedCheck === 'manifest-trust' ? options.manifestPath : options.manifestBundlePath)) {
          throw failure;
        }
      });
    } else if (failedCheck === 'manifest-read' || failedCheck === 'bundle-read') {
      await fs.unlink(failedCheck === 'manifest-read' ? options.manifestPath : options.manifestBundlePath);
    }
    const publish = jest.fn();
    const report = new HostPreflightReporter('bounded-artifacts', publish, undefined,
      { phase: 'preflight', profile: 'common' });
    const attempts = jest.spyOn(HostPreflightReporter.prototype, 'attempt');
    const verificationRoot = failedCheck === 'verification-directory' ? path.join(directory, 'missing') : directory;
    await expect(preflightCloudHypervisorEnclaveArtifacts(options, verificationRoot, undefined, report)).rejects.toThrow();
    const order = [
      'operator-identity', 'tool-gh', 'manifest-bundle-path', 'manifest-trust', 'bundle-trust',
      'manifest-read', 'bundle-read', 'verification-directory', 'manifest-parse',
    ];
    expect(attempts.mock.calls.map(([id]) => id)).toEqual(order.slice(0, order.indexOf(failedCheck) + 1));
    const record = publish.mock.calls[publish.mock.calls.length - 1][0];
    expect(record.checks.find((check: { id: string }) => check.id === failedCheck)?.result).toBe('failed');
    for (const id of ['manifest-attestation', 'rootfs-configuration', 'rootfs-trust', 'sbom-trust']) {
      expect(record.checks.find((check: { id: string }) => check.id === id)?.result).toBe('not-attempted');
    }
    expect(JSON.stringify(publish.mock.calls)).not.toContain('PRIVATE_SENTINEL');
    expect((await fs.readdir(directory)).filter(name => name.startsWith('awf-enclave-attestation-'))).toEqual([]);
  });
});
