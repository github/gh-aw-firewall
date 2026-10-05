import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';

const repoRoot = path.join(__dirname, '..', '..');
const containersRoot = path.join(repoRoot, 'containers');
const dockerfilePath = path.join(containersRoot, 'enclave', 'Dockerfile');

describe('enclave image contract', () => {
  it('builds all three enclave images from one neutral Dockerfile', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    for (const target of ['AS enclave-script', 'AS enclave-agent', 'AS enclave-mcp-server']) {
      expect(dockerfile).toContain(target);
    }
    for (const copy of [
      'COPY bounded-execution/ /opt/awf/bounded-execution/',
      'COPY enclave/script-executor/ /opt/awf/enclave/script-executor/',
      'COPY enclave/agent-executor/ /opt/awf/enclave/agent-executor/',
      'COPY enclave/mcp-server/ /opt/awf/enclave/mcp-server/',
      'COPY enclave/seccomp.json /opt/awf/enclave-seccomp.json',
    ]) {
      expect(dockerfile).toContain(copy);
    }
  });

  it('resolves the complete server module graph from the image layout', () => {
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-enclave-image-'));
    const awf = path.join(stage, 'opt', 'awf');
    try {
      fs.mkdirSync(awf, { recursive: true });
      for (const [source, destination] of [
        ['bounded-execution', 'bounded-execution'],
        ['enclave/script-executor', 'enclave/script-executor'],
        ['enclave/agent-executor', 'enclave/agent-executor'],
        ['enclave/mcp-server', 'enclave/mcp-server'],
      ]) {
        fs.cpSync(path.join(containersRoot, source), path.join(awf, destination), { recursive: true });
      }
      for (const relative of [
        'enclave/mcp-server/server.js',
        'enclave/mcp-server/agent-executor.js',
        'enclave/mcp-server/config.js',
        'enclave/mcp-server/mcp-protocol.js',
        'enclave/agent-executor/enclave-runner.js',
        'enclave/agent-executor/workspace.js',
        'enclave/agent-executor/framing.js',
        'enclave/script-executor/executor-handler.js',
        'enclave/script-executor/script-runner.js',
      ]) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(require(path.join(awf, relative))).toBeDefined();
      }
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('launches Copilot through the copied Node interpreter without env', () => {
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    const patch = dockerfile.match(
      /RUN sed -i '([^']+)' \/usr\/local\/lib\/node_modules\/@github\/copilot\/npm-loader\.js/,
    );
    expect(patch?.[1]).toBe('1c#!/usr/local/bin/node');
    expect(dockerfile).toContain(
      'ln -s ../lib/node_modules/@github/copilot/npm-loader.js /usr/local/bin/copilot',
    );
    expect(dockerfile.match(/copilot --version \| grep -q "GitHub Copilot CLI \$\{COPILOT_CLI_VERSION\}"/g))
      .toHaveLength(2);
    expect(dockerfile).toContain("node --version | grep -qE '^v24\\.'");

    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-copilot-launcher-'));
    try {
      const loader = path.join(stage, 'npm-loader.js');
      const launcher = path.join(stage, 'copilot');
      const body = [
        'console.log(JSON.stringify(process.argv.slice(2)));',
        'process.exit(process.argv.includes("--fail") ? 23 : 0);',
        '',
      ].join('\n');
      fs.writeFileSync(loader, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
      fs.symlinkSync('npm-loader.js', launcher);
      execFileSync('sed', ['-i', patch![1].replace('/usr/local/bin/node', process.execPath), loader]);
      expect(fs.readFileSync(loader, 'utf8')).toBe(`#!${process.execPath}\n${body}`);
      // An empty PATH ensures the launcher cannot fall back to env's Node lookup.
      const options = { encoding: 'utf8' as const, env: { ...process.env, PATH: stage } };
      expect(JSON.parse(execFileSync(launcher, ['--version', 'argument with spaces', ''], options)))
        .toEqual(['--version', 'argument with spaces', '']);
      expect(spawnSync(launcher, ['--fail'], options).status).toBe(23);
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  });

  it('publishes only the unified enclave images', () => {
    const release = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'release.yml'), 'utf8');
    expect(release).toContain('file: ./containers/enclave/Dockerfile');
    for (const image of ['enclave-script', 'enclave-agent', 'enclave-mcp-server']) {
      expect(release).toContain(image);
    }
  });
});
