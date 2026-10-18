import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFileSync, spawnSync } from 'child_process';
import { gzipSync } from 'zlib';

const setupPath = path.resolve(__dirname, '../../guest/cloud-hypervisor/setup-enclave-artifacts.sh');
const tag = 'v1.2.3';
const manifestName = 'cloud-hypervisor-enclave-rootfs-x86_64.manifest.json';
const digest = (data: string) => createHash('sha256').update(data).digest('hex');
const pythonPath = execFileSync('bash', ['-c', 'command -v python3'], { encoding: 'utf8' }).trim();

describe('release enclave artifact setup', () => {
  let directory: string;
  let assets: string;
  let cache: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-setup-'));
    assets = path.join(directory, 'assets');
    cache = path.join(directory, 'cache', tag, 'x86_64');
    log = path.join(directory, 'gh.log');
    const bin = path.join(directory, 'bin');
    fs.mkdirSync(assets);
    fs.mkdirSync(bin);
    const writeTool = (name: string, source: string) => fs.writeFileSync(
      path.join(bin, name), `#!${process.execPath}\n${source}\n`, { mode: 0o700 },
    );
    writeTool('flock', '');
    writeTool('stat', `
      const fs = require('fs');
      const [, format, file] = process.argv.slice(2);
      const stat = fs.statSync(file);
      console.log(format === '%a' ? (stat.mode & 0o7777).toString(8) : stat.size);
    `);
    writeTool('sha256sum', `
      const fs = require('fs');
      const crypto = require('crypto');
      const file = process.argv[2];
      console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') + '  ' + file);
    `);
    writeTool('python3', `
      const fs = require('fs');
      const { spawnSync } = require('child_process');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(['decompress', ...args]) + '\\n');
      const result = spawnSync(${JSON.stringify(pythonPath)}, args, { stdio: 'inherit' });
      if (result.error) throw result.error;
      process.exit(result.status === null ? 1 : result.status);
    `);
    writeTool('rm', `
      const fs = require('fs');
      const path = require('path');
      const target = process.argv[process.argv.length - 1];
      if (!target.startsWith(process.env.FIXTURE_DIRECTORY + path.sep)) {
        throw new Error('Cleanup outside fixture directory');
      }
      if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        for (const name of fs.readdirSync(target).filter(name => name.endsWith('.ext4'))) {
          const size = fs.statSync(path.join(target, name)).size;
          fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(['cleanup', name, size]) + '\\n');
        }
      }
      fs.rmSync(target, { recursive: true, force: true });
    `);
    writeTool('gh', `
      const fs = require('fs');
      const path = require('path');
      const args = process.argv.slice(2);
      fs.appendFileSync(process.env.FIXTURE_GH_LOG, JSON.stringify(args) + '\\n');
      if (args[0] === 'release' && args[1] === 'download') {
        const target = args[args.indexOf('--dir') + 1];
        for (let i = 0; i < args.length; i++) {
          if (args[i] !== '--pattern') continue;
          const pattern = args[++i];
          const names = fs.readdirSync(process.env.FIXTURE_ASSETS).filter(name =>
            pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern);
          if (!names.length) throw new Error('No matching release asset: ' + pattern);
          for (const name of names) {
            fs.copyFileSync(path.join(process.env.FIXTURE_ASSETS, name), path.join(target, name));
          }
        }
      } else if (args[0] === 'attestation' && args[1] === 'verify') {
        if (path.basename(args[2]) === process.env.FIXTURE_REJECT_SUBJECT) {
          console.error('fixture attestation rejected');
          process.exit(1);
        }
      } else {
        throw new Error('Unexpected gh invocation: ' + args.join(' '));
      }
    `);
    env = {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FIXTURE_ASSETS: assets,
      FIXTURE_GH_LOG: log,
      FIXTURE_DIRECTORY: directory,
      GITHUB_ENV: '',
    };
  });

  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  function fixture(compressed: boolean) {
    const rootfs: Record<string, unknown> = {};
    const name = 'enclave-rootfs.ext4';
    const contents = 'verified shared rootfs';
    fs.writeFileSync(path.join(assets, `${name}${compressed ? '.gz' : ''}`),
      compressed ? gzipSync(contents) : contents);
    fs.writeFileSync(path.join(assets, 'enclave-rootfs.provenance.sigstore.jsonl'), '{}');
    for (const role of ['script', 'agent']) {
      const sbomName = `enclave-${role}-rootfs.sbom.spdx.json`;
      fs.writeFileSync(path.join(assets, sbomName), '{}');
      rootfs[role] = {
        role, file: name, version: tag, uid: 65534, gid: 65534,
        entrypoint: `/usr/local/bin/run-enclave-${role}`,
        sourceImage: `ghcr.io/github/gh-aw-firewall/cloud-hypervisor-enclave@sha256:${'a'.repeat(64)}`,
        sourceImageDigest: 'a'.repeat(64),
        sha256: digest(contents), sizeBytes: Buffer.byteLength(contents),
        sbom: { file: sbomName, sha256: digest('{}') },
      };
    }
    fs.writeFileSync(path.join(assets, manifestName), JSON.stringify({
      schemaVersion: 1, artifactType: 'awf-cloud-hypervisor-enclave-rootfs-set',
      architecture: 'x86_64',
      release: {
        repository: 'github/gh-aw-firewall',
        workflow: 'github/gh-aw-firewall/.github/workflows/release.yml',
        tag, sourceCommit: 'a'.repeat(40),
      },
      compatibility: {
        cloudHypervisorVersion: '53.0', kernelVersion: '6.1.141', supervisorVersion: tag,
      },
      guestBase: {
        image: `ghcr.io/github/gh-aw-firewall/cloud-hypervisor-guest-base@sha256:${'a'.repeat(64)}`,
        imageId: `sha256:${'a'.repeat(64)}`,
      },
      rootfs,
    }));
    fs.writeFileSync(path.join(assets, manifestName.replace('.json', '.sigstore.jsonl')), '{}');
    for (const file of fs.readdirSync(assets)) {
      fs.chmodSync(path.join(assets, file), 0o600);
    }
  }

  function runSetup() {
    return spawnSync('bash', [setupPath, tag, path.join(directory, 'cache')], {
      env, encoding: 'utf8', timeout: 30000,
    });
  }

  it.each([true, false])('verifies and caches compressed=%s assets, then re-verifies without downloading', (compressed) => {
    fixture(compressed);
    const result = runSetup();
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const name = 'enclave-rootfs.ext4';
    expect(fs.readFileSync(path.join(cache, name), 'utf8')).toBe('verified shared rootfs');
    expect(fs.existsSync(path.join(cache, `${name}.gz`))).toBe(false);
    expect(fs.statSync(path.join(cache, name)).mode & 0o777).toBe(0o400);
    expect(result.stdout).toContain(path.join(cache, name));
    expect(runSetup().status).toBe(0);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
      .map((line) => JSON.parse(line) as string[]);
    expect(calls.filter((args) => args[0] === 'release')).toHaveLength(1);
    expect(calls.filter((args) => args[0] === 'attestation')).toHaveLength(4);
  }, 30000);

  it.each(['gzip', 'digest', 'attestation', 'size'] as const)('does not install a cache after %s failure', (failure) => {
    fixture(true);
    const agent = path.join(assets, 'enclave-rootfs.ext4.gz');
    if (failure === 'gzip') fs.writeFileSync(agent, 'not gzip');
    if (failure === 'digest') fs.writeFileSync(agent, gzipSync('tampered shared rootfs'));
    if (failure === 'attestation') env.FIXTURE_REJECT_SUBJECT = 'enclave-rootfs.ext4';
    if (failure === 'size') {
      const file = path.join(assets, manifestName);
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        rootfs: { agent: { sizeBytes: number }; script: { sizeBytes: number } };
      };
      manifest.rootfs.agent.sizeBytes++;
      manifest.rootfs.script.sizeBytes = manifest.rootfs.agent.sizeBytes;
      fs.writeFileSync(file, JSON.stringify(manifest));
    }
    const result = runSetup();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch({
      gzip: /not.*gzip/i,
      digest: /script enclave rootfs digest mismatch/,
      attestation: /fixture attestation rejected/,
      size: /shared enclave rootfs size mismatch/,
    }[failure]);
    expect(fs.existsSync(cache)).toBe(false);
    expect(fs.readdirSync(path.dirname(cache)).filter((name) => name.startsWith('.staging.')))
      .toEqual([]);
    expect(result.stdout).not.toContain('export AWF_');
  }, 30000);

  it.each(['attestation', 'release', 'filename'] as const)(
    'rejects an invalid manifest %s before any decompression',
    (failure) => {
      fixture(true);
      if (failure === 'attestation') {
        env.FIXTURE_REJECT_SUBJECT = manifestName;
      } else {
        const file = path.join(assets, manifestName);
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
          release: { tag: string }; rootfs: { agent: { file: string } };
        };
        if (failure === 'release') manifest.release.tag = 'v9.9.9';
        if (failure === 'filename') manifest.rootfs.agent.file = '../unexpected.ext4';
        fs.writeFileSync(file, JSON.stringify(manifest));
      }
      const result = runSetup();
      expect(result.status).not.toBe(0);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('"decompress"');
      expect(fs.existsSync(cache)).toBe(false);
    },
    30000,
  );

  it.each([null, '20', -1, 0, 1.5, 9007199254740992])(
    'rejects invalid attested size %s before any decompression',
    (sizeBytes) => {
      fixture(true);
      const file = path.join(assets, manifestName);
      const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        rootfs: { agent: { sizeBytes: unknown } };
      };
      manifest.rootfs.agent.sizeBytes = sizeBytes;
      fs.writeFileSync(file, JSON.stringify(manifest));
      const result = runSetup();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/agent enclave rootfs size is invalid/);
      expect(fs.readFileSync(log, 'utf8')).not.toContain('"decompress"');
      expect(fs.existsSync(cache)).toBe(false);
    },
    30000,
  );

  it.each(['one byte', 'high compression', 'concatenated members'] as const)(
    'caps decompressed output at the attested size for %s overflow',
    (overflow) => {
      fixture(true);
      const contents = 'verified shared rootfs';
      const payload = overflow === 'concatenated members'
        ? Buffer.concat([gzipSync(contents), gzipSync('extra')])
        : gzipSync(overflow === 'one byte' ? `${contents}!` : Buffer.alloc(8 * 1024 * 1024));
      fs.writeFileSync(path.join(assets, 'enclave-rootfs.ext4.gz'), payload);
      const result = runSetup();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/shared enclave rootfs exceeds attested size/);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => JSON.parse(line) as Array<string | number>);
      expect(calls.find((args) => args[0] === 'attestation')?.[2])
        .toContain(manifestName);
      expect(calls.find((args) => args[0] === 'cleanup'
        && args[1] === 'enclave-rootfs.ext4')?.[2])
        .toBe(Buffer.byteLength(contents));
      expect(fs.existsSync(cache)).toBe(false);
      expect(fs.readdirSync(path.dirname(cache)).filter((name) => name.startsWith('.staging.')))
        .toEqual([]);
      expect(result.stdout).not.toContain('export AWF_');
    },
    30000,
  );

  it('rejects a corrupt gzip trailer even when the output has the attested size', () => {
    fixture(true);
    const compressed = gzipSync('verified shared rootfs');
    compressed[compressed.length - 8] ^= 0xff;
    fs.writeFileSync(path.join(assets, 'enclave-rootfs.ext4.gz'), compressed);
    const result = runSetup();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/(checksum|crc|length)/i);
    expect(fs.existsSync(cache)).toBe(false);
  }, 30000);
});
