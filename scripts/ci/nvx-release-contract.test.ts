import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildNvxOneShotArguments,
  type NvxOneShotExecutionRequest,
} from '../../src/nvx/one-shot-adapter';
import { buildDirectOpenvmmArguments } from '../../src/nvx/runtime-lifecycle';
import type { NvxLiveMount } from '../../src/nvx/live-mount-policy';

// Opt in with an extracted, unmodified v0.1.0-dev.8fb0f1d64f2f release.
const packageRoot = process.env.AWF_NVX_PACKAGE_ROOT;
const releaseContract = packageRoot === undefined ? describe.skip : describe;
const OPENVMM_REVISION = '0ac254109ed32fc5fa2b1a6fc526a10593b1f986';

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function shellWords(command: string): string[] {
  return JSON.parse(execFileSync('python3', [
    '-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))',
    command,
  ], { encoding: 'utf8' })) as string[];
}

function flags(args: readonly string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const switches = new Set(['--paused', '--single-process']);
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    expect(flag).toMatch(/^--/);
    const value = switches.has(flag) ? 'true' : args[++i];
    expect(value).toBeDefined();
    (result[flag] ??= []).push(value);
  }
  return result;
}

function normalized(
  args: readonly string[],
  diskPaths: Readonly<Record<string, string>>,
): Record<string, string[]> {
  const parsed = flags(args);
  // AWF starts paused for confinement and pins a CPU profile independently.
  delete parsed['--paused'];
  delete parsed['--cpu-profile'];
  for (const [flag, values] of Object.entries(parsed)) {
    parsed[flag] = values.map((value) => {
      if (flag === '--cmdline') return shellWords(value).sort().join(' ');
      if (flag === '--microvm-sandbox-block') {
        const role = value.split(':')[0];
        return value.replace(/:file:\/proc\/self\/fd\/\d+(?=,|$)/, `:file:${diskPaths[role]}`);
      }
      if (flag === '--kernel' || flag === '--initrd') return path.basename(value);
      return value;
    }).sort();
  }
  return parsed;
}

releaseContract('pinned real NVX release launch contract', () => {
  let root: string;
  let request: NvxOneShotExecutionRequest;
  let shares: NvxLiveMount[];
  let distroUuid: string;

  beforeAll(() => {
    const release = path.resolve(packageRoot!);
    const source = JSON.parse(fs.readFileSync(path.join(release, 'SOURCE-MANIFEST.json'), 'utf8'));
    expect(source.openvmm.source_revision).toBe(OPENVMM_REVISION);
    expect(sha256(path.join(release, 'bin', 'openvmm')))
      .toBe('3fc5475d535d3ef8c1116f511ba2dc1e43ace2fa910cdb41be351b75da99a5da');
    expect(sha256(path.join(release, 'bin', 'nvx-rs')))
      .toBe('918db1842bafe0e73a3f2261b09fd7d34157af01bd1b45394ae44f97056346d3');
    expect(sha256(path.join(release, 'SOURCE-MANIFEST.json')))
      .toBe('6c056cb6dabde9aaccea4402e56b63d83768dc5c31af300acb10d7d87a66e32e');
    const sums = fs.readFileSync(path.join(release, 'SHA256SUMS'), 'utf8').trim().split('\n');
    for (const line of sums) {
      const match = /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line);
      expect(match).not.toBeNull();
      const file = path.resolve(release, match![2]);
      expect(file.startsWith(`${release}${path.sep}`)).toBe(true);
      expect(sha256(file)).toBe(match![1]);
    }
    const guest = path.join(release, 'guest');
    const manifestPath = path.join(guest, 'ubuntu-distro.erofs.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    distroUuid = manifest.uuid;
    expect(distroUuid).toBe('1defc274-c6a3-2ae5-8d79-214028a6128d');
    expect(sha256(path.join(guest, 'ubuntu-distro.erofs'))).toBe(manifest.artifact_sha256);

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nvx-release-contract-'));
    const distro = path.join(root, 'distro.erofs');
    const scratch = path.join(root, 'scratch.ext4');
    fs.copyFileSync(path.join(guest, 'ubuntu-distro.erofs'), distro, fs.constants.COPYFILE_FICLONE);
    fs.copyFileSync(path.join(guest, 'ubuntu-smoke-scratch.ext4'), scratch, fs.constants.COPYFILE_FICLONE);
    const first = path.join(root, 'first share');
    const second = path.join(root, 'second');
    fs.mkdirSync(path.join(first, 'secret'), { recursive: true });
    fs.mkdirSync(second);
    fs.writeFileSync(path.join(first, 'secret', 'allowed'), 'visible\n');
    fs.writeFileSync(path.join(second, 'writable'), 'writable\n');
    fs.writeFileSync(path.join(root, 'single-file'), 'one file\n');
    shares = [
      {
        tag: 'first', guestTarget: '/workspace', hostPath: first, mode: 'ro',
        deniedPaths: [path.join(first, 'secret')],
        allowedPaths: [path.join(first, 'secret', 'allowed')], writablePaths: [],
      },
      {
        tag: 'second', guestTarget: '/output', hostPath: second, mode: 'rw',
        deniedPaths: [], allowedPaths: [], writablePaths: [path.join(second, 'writable')],
      },
    ];
    request = {
      nvxRoot: guest,
      filesystem: {
        runDirectory: root, manifestPath: path.join(root, 'manifest.json'), sourceDateEpoch: 0,
        layers: [{
          role: 'distro', path: distro, uuid: distroUuid, sha256: manifest.artifact_sha256,
          sourceManifestSha256: sha256(manifestPath), sourceEntries: 0, excludedPaths: [],
        }],
        scratch: {
          path: scratch, uuid: '00000000-0000-4000-8000-000000000001',
          sizeBytes: fs.statSync(scratch).size, uid: 65534, gid: 65534,
        },
      },
      entrypoint: '/bin/true', args: ['--version'], hostname: 'awf-nvx',
      workloadUid: 65534, workloadGid: 65534,
      memoryMib: 512, memoryMaxBytes: 268435456, pidsMax: 17,
      network: {
        guestAddress: '172.30.0.2/24',
        egressAllow: ['172.30.0.10/32:tcp:3128'],
        egressDeny: ['169.254.169.254/32'],
      },
    };
  }, 120_000);

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  test.each(['no mount', 'single directory', 'multiple directories with policies', 'single file'])(
    '%s agrees with the real nvx-rs dry-run',
    (name) => {
      const mounts = name === 'no mount' ? [] :
        name === 'single directory' ? [shares[0]] :
          name === 'multiple directories with policies' ? shares :
            [{
              tag: 'file', guestTarget: '/input', hostPath: path.join(root, 'single-file'),
              mode: 'ro' as const, file: true, deniedPaths: [], allowedPaths: [], writablePaths: [],
            }];
      const execution = { ...request, mounts };
      const outcome = path.join(root, 'outcome.json');
      const launcher = path.join(path.resolve(packageRoot!), 'bin', 'nvx-rs');
      const output = execFileSync(launcher, [
        ...buildNvxOneShotArguments(execution, outcome), '--dry-run',
      ], { encoding: 'utf8', timeout: 30_000 });
      const commands = output.split('\n').filter((line) => line.startsWith('>> '));
      expect(commands).toHaveLength(1);
      const [binary, ...actual] = shellWords(commands[0].slice(3));
      expect(binary).toBe(path.join(path.resolve(packageRoot!), 'bin', 'openvmm'));
      const direct = buildDirectOpenvmmArguments(execution, outcome);
      expect(flags(direct)['--paused']).toEqual(['true']);
      expect(flags(direct)['--cpu-profile']).toEqual(['host']);
      const diskPaths = {
        distro: request.filesystem.layers[0].path,
        scratch: request.filesystem.scratch.path,
      };
      expect(normalized(direct, diskPaths)).toEqual(normalized(actual, diskPaths));
      const parsed = flags(actual);
      const kernel = shellWords(parsed['--cmdline'][0]);
      expect(kernel.filter((token) => token.startsWith('nvx_layer='))).toEqual([
        `nvx_layer=distro,0xd0003000,erofs:${distroUuid}`,
      ]);
      expect(parsed['--microvm-sandbox-block']).toHaveLength(2);
      expect(parsed['--microvm-sandbox-block'][0]).toMatch(/^distro:file:.+,ro$/);
      expect(parsed['--microvm-sandbox-block'][1]).toMatch(/^scratch:file:[^,]+$/);
      expect(parsed['--network-egress']).toEqual(['deny']);
      expect(parsed['--network-ingress']).toEqual(['deny']);
      expect(parsed['--host-loopback']).toEqual(['deny']);
      expect(parsed['--microvm-workload-identity']).toEqual(['65534:65534']);
      expect(kernel).toContain('nvx_pids_max=18');
      if (mounts.length > 1 || mounts.some((mount) => mount.file)) {
        expect(parsed['--mount-aggregate']).toEqual(['/run/nvx/shares']);
        expect(parsed['--mount-child']).toHaveLength(mounts.length);
        expect(kernel.filter((token) => token.startsWith('nvx_share='))).toHaveLength(mounts.length);
        expect(parsed['--mount']).toBeUndefined();
      }
    },
    30_000,
  );
});
