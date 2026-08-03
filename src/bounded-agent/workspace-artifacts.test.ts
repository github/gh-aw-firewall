import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { generateBoundedAgentSkill, writeBoundedAgentSkill } from './skill';
import { writeBoundedAgentWrapper } from './wrapper-artifact';
import { resolveBoundedAgentPaths } from './paths';

/* eslint-disable @typescript-eslint/no-require-imports */
const brokerDir = path.join(__dirname, '..', '..', 'containers', 'bounded-agent', 'broker');
const workspace = require(path.join(brokerDir, 'workspace.js'));
/* eslint-enable @typescript-eslint/no-require-imports */

describe('bounded-agent invocation workspace', () => {
  let root: string;
  let config: Record<string, unknown>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-ws-'));
    config = { workDir: root, enclaveUid: process.getuid?.() ?? 0, enclaveGid: process.getgid?.() ?? 0 };
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('materializes only the task, schema, and result file — never a repository copy', () => {
    const layout = workspace.createInvocationWorkspace({
      config,
      invocationId: 'abc123',
      task: 'the task',
      schema: { type: 'boolean' },
    });

    expect(fs.readdirSync(layout.root).sort()).toEqual(['out', 'schema.json', 'task.txt']);
    expect(fs.readFileSync(layout.taskPath, 'utf8')).toBe('the task');
    expect(JSON.parse(fs.readFileSync(layout.schemaPath, 'utf8'))).toEqual({ type: 'boolean' });
    expect(fs.readFileSync(layout.outPath, 'utf8')).toBe('');
  });

  it('makes the task and schema read-only inside the enclave mount source', () => {
    const layout = workspace.createInvocationWorkspace({
      config,
      invocationId: 'abc123',
      task: 'the task',
      schema: { type: 'boolean' },
    });
    expect(fs.statSync(layout.taskPath).mode & 0o222).toBe(0);
    expect(fs.statSync(layout.schemaPath).mode & 0o222).toBe(0);
  });

  it('reads back a result of exactly the permitted size', () => {
    const layout = workspace.createInvocationWorkspace({
      config,
      invocationId: 'abc123',
      task: 't',
      schema: { type: 'boolean' },
    });
    fs.writeFileSync(layout.outPath, 'true');
    expect(workspace.readEnclaveOutput(layout.outPath, 4)).toBe('true');
    expect(workspace.readEnclaveOutput(layout.outPath, 3)).toBeUndefined();
  });

  it('rejects a missing result file', () => {
    expect(workspace.readEnclaveOutput(path.join(root, 'nope'), 100)).toBeUndefined();
  });

  it('rejects a symlinked result file', () => {
    const target = path.join(root, 'secret');
    fs.writeFileSync(target, 'true');
    const link = path.join(root, 'out');
    fs.symlinkSync(target, link);
    expect(workspace.readEnclaveOutput(link, 100)).toBeUndefined();
  });

  it('rejects a non-regular result file', () => {
    const fifo = path.join(root, 'fifo');
    fs.mkdirSync(fifo);
    expect(workspace.readEnclaveOutput(fifo, 100)).toBeUndefined();
  });

  it('rejects invalid UTF-8', () => {
    const out = path.join(root, 'out');
    fs.writeFileSync(out, Buffer.from([0xff, 0xfe, 0xfd]));
    expect(workspace.readEnclaveOutput(out, 100)).toBeUndefined();
  });

  it('destroys the workspace idempotently', () => {
    workspace.createInvocationWorkspace({
      config,
      invocationId: 'abc123',
      task: 't',
      schema: { type: 'boolean' },
    });
    workspace.destroyInvocationWorkspace(root, 'abc123');
    workspace.destroyInvocationWorkspace(root, 'abc123');
    expect(fs.existsSync(path.join(root, 'abc123'))).toBe(false);
  });
});

describe('generated bounded-agent skill', () => {
  const params = {
    repos: [
      { repo: 'octo/alpha', sensitivity: 'internal' as const },
      { repo: 'octo/sealed', sensitivity: 'sealed' as const },
      { repo: 'octo/open', sensitivity: 'public' as const },
    ],
    timeoutSeconds: 120,
    maxInvocations: 8,
    maxTaskBytes: 4096,
    profile: 'openai' as const,
    maxModelRequests: 8,
  };

  it('lists each repository with its fixed run budget', () => {
    const skill = generateBoundedAgentSkill(params);
    expect(skill).toContain('`octo/alpha` — 64 bits/run (`internal`)');
    expect(skill).toContain('`octo/sealed` — 0 bits/run (`sealed` — never runs an enclave)');
    expect(skill).toContain('`octo/open` — unmetered (`public`)');
  });

  it('documents the canonical envelopes and the fixed CLI surface', () => {
    const skill = generateBoundedAgentSkill(params);
    expect(skill).toContain('{"status":"error"}');
    expect(skill).toContain('{"status":"ok","result":<value>}');
    expect(skill).toContain('exactly one `--repo`');
    expect(skill).toContain('exactly one `--schema`');
  });

  it('states that no capability-bearing option exists', () => {
    const skill = generateBoundedAgentSkill(params);
    for (const forbidden of [
      'image', 'command', 'executable', 'model', 'provider', 'profile', 'tools', 'system prompt',
      'runtime', 'timeout', 'mount', 'path', 'network', 'proxy', 'endpoint', 'resource limit',
      'environment', 'credentials',
    ]) {
      expect(skill).toContain(forbidden);
    }
  });

  it('never discloses the remaining budget', () => {
    const skill = generateBoundedAgentSkill(params);
    expect(skill).toContain('remaining balance itself is never disclosed');
  });

  it('states that the ledger is separate from bounded queries', () => {
    expect(generateBoundedAgentSkill(params)).toContain('ledger **separate** from bounded queries');
  });
});

describe('bounded-agent agent artifacts', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-artifacts-'));
  });

  afterEach(() => {
    fs.rmSync(resolveBoundedAgentPaths(workDir).ingressRoot, { recursive: true, force: true });
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('writes a world-readable skill and an executable wrapper into the ingress root only', () => {
    const paths = resolveBoundedAgentPaths(workDir);
    fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });

    writeBoundedAgentSkill(paths, {
      repos: [{ repo: 'octo/alpha', sensitivity: 'internal' }],
      timeoutSeconds: 120,
      maxInvocations: 8,
      maxTaskBytes: 4096,
      profile: 'openai',
      maxModelRequests: 8,
    });
    writeBoundedAgentWrapper(paths);

    expect(fs.statSync(paths.skillPath).mode & 0o777).toBe(0o644);
    // Open with O_NOFOLLOW to avoid TOCTOU between stat and read.
    const wrapperFd = fs.openSync(paths.wrapperPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      expect(fs.fstatSync(wrapperFd).mode & 0o777).toBe(0o555);
      expect(fs.readFileSync(wrapperFd, 'utf8')).toContain('AWF_BOUNDED_AGENT_SOCKET');
    } finally {
      fs.closeSync(wrapperFd);
    }
    // Nothing is written into the broker-private root.
    expect(fs.existsSync(paths.root)).toBe(false);
  });

  it('refuses to overwrite a pre-existing artifact', () => {
    const paths = resolveBoundedAgentPaths(workDir);
    fs.mkdirSync(paths.agentDir, { recursive: true, mode: 0o755 });
    fs.writeFileSync(paths.wrapperPath, 'planted');

    expect(() => writeBoundedAgentWrapper(paths)).toThrow(/EEXIST/);
  });
});

describe('bounded-agent CLI wrapper source', () => {
  const wrapper = fs.readFileSync(
    path.join(__dirname, '..', '..', 'containers', 'agent', 'bounded-agent-wrapper.sh'),
    'utf8',
  );

  it('accepts only --repo and --schema plus stdin', () => {
    expect(wrapper).toContain('--repo)');
    expect(wrapper).toContain('--schema)');
    // Everything else falls through to the canonical error.
    expect(wrapper).toContain('*)\n      # Any other flag');
  });

  it('always emits a canonical envelope and exits 0', () => {
    expect(wrapper).toContain("CANONICAL_ERROR='{\"status\":\"error\"}'");
    expect(wrapper).not.toMatch(/exit\s+[1-9]/);
  });

  it('never forwards a proxy, credential, or runtime control', () => {
    expect(wrapper).toContain("--noproxy '*'");
    for (const forbidden of ['AWF_BOUNDED_AGENT_MODEL', 'Authorization', 'X-AWF-Runtime']) {
      expect(wrapper).not.toContain(forbidden);
    }
  });

  it('uses the authenticated host-gateway endpoint only when the sbx transport is complete', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-bounded-agent-wrapper-'));
    const argsPath = path.join(root, 'curl.args');
    const fakeCurl = path.join(root, 'curl');
    fs.writeFileSync(
      fakeCurl,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "$AWF_TEST_CURL_ARGS"\nprintf '%s' '{"status":"error"}'\n`,
      { mode: 0o755 },
    );
    try {
      const capability = 'a'.repeat(64);
      const result = spawnSync(
        '/bin/sh',
        [
          path.join(__dirname, '..', '..', 'containers', 'agent', 'bounded-agent-wrapper.sh'),
          '--repo',
          'octo/alpha',
          '--schema',
          '{"type":"boolean"}',
        ],
        {
          input: 'bounded task',
          encoding: 'utf8',
          env: {
            PATH: `${root}:${process.env.PATH ?? ''}`,
            AWF_TEST_CURL_ARGS: argsPath,
            AWF_BOUNDED_AGENT_ENDPOINT: 'http://host.docker.internal:18081/query',
            AWF_BOUNDED_AGENT_CAPABILITY: capability,
          },
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toBe('{"status":"error"}\n');
      expect(result.stderr).toBe('');
      const curlArgs = fs.readFileSync(argsPath, 'utf8');
      expect(curlArgs).toContain('X-AWF-Capability: ' + capability);
      expect(curlArgs).toContain('http://host.docker.internal:18081/query');
      expect(curlArgs).toContain('--noproxy');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('only ever passes through the two canonical response shapes', () => {
    expect(wrapper).toContain('\'{"status":"error"}\')');
    expect(wrapper).toContain('\'{"status":"ok","result":\'*\'}\')');
  });
});
