import * as path from 'path';
import {
  AGENT_SKILL_DIR,
  AGENT_SKILL_PATH,
  AGENT_SOCKET_DIR,
  AGENT_SOCKET_PATH,
  deriveSeedId,
  generateBoundedQueryRunId,
  normalizeRepoKey,
  resolveBoundedQueryPaths,
} from './paths';

describe('bounded-query paths', () => {
  const workDir = '/tmp/awf-12345';
  const privateBaseDir = '/var/tmp/awf-test-private';

  it('separates broker-private state from agent-visible ingress', () => {
    const paths = resolveBoundedQueryPaths(workDir, privateBaseDir);

    expect(paths.root.startsWith(`${privateBaseDir}/awf-bounded-query-private-`)).toBe(true);
    expect(paths.root.startsWith('/tmp')).toBe(false);
    expect(paths.ingressRoot.startsWith(`${privateBaseDir}/awf-bounded-query-ingress-`)).toBe(true);
    expect(paths.ingressRoot.startsWith(workDir)).toBe(false);
    expect(paths.seedsDir.startsWith(paths.root)).toBe(true);
    expect(paths.workDir.startsWith(paths.root)).toBe(true);
    expect(paths.controlDir.startsWith(paths.root)).toBe(true);
    expect(paths.auditDir.startsWith(paths.root)).toBe(true);
    expect(paths.seedMapPath.startsWith(paths.root)).toBe(true);
    expect(paths.capabilityPath.startsWith(paths.controlDir)).toBe(true);
    expect(paths.runDir.startsWith(paths.ingressRoot)).toBe(true);
    expect(paths.agentDir.startsWith(paths.ingressRoot)).toBe(true);
    expect(paths.wrapperPath.startsWith(paths.agentDir)).toBe(true);
  });

  it('places the socket and skill inside their advertised directories', () => {
    const paths = resolveBoundedQueryPaths(workDir);

    expect(paths.socketPath).toBe(path.join(paths.runDir, 'broker.sock'));
    expect(paths.skillPath).toBe(path.join(paths.agentDir, 'SKILL.md'));
    expect(AGENT_SOCKET_PATH.startsWith(`${AGENT_SOCKET_DIR}/`)).toBe(true);
    expect(AGENT_SKILL_PATH.startsWith(`${AGENT_SKILL_DIR}/`)).toBe(true);
  });

  it('keeps the run and agent directories separate so the skill can be read-only', () => {
    const paths = resolveBoundedQueryPaths(workDir);
    expect(paths.runDir).not.toBe(paths.agentDir);
    expect(AGENT_SOCKET_DIR).not.toBe(AGENT_SKILL_DIR);
  });
});

describe('normalizeRepoKey', () => {
  it('lowercases and trims so lookups match GitHub case-insensitivity', () => {
    expect(normalizeRepoKey('  My-Org/My-Repo ')).toBe('my-org/my-repo');
  });
});

describe('deriveSeedId', () => {
  const runId = 'a'.repeat(32);

  it('is deterministic within a run', () => {
    expect(deriveSeedId(runId, 'octo/repo')).toBe(deriveSeedId(runId, 'octo/repo'));
  });

  it('ignores repository case, matching the lookup key', () => {
    expect(deriveSeedId(runId, 'Octo/Repo')).toBe(deriveSeedId(runId, 'octo/repo'));
  });

  it('differs per repository', () => {
    expect(deriveSeedId(runId, 'octo/a')).not.toBe(deriveSeedId(runId, 'octo/b'));
  });

  it('differs across runs, so a seed path is not predictable from the repo name', () => {
    expect(deriveSeedId(runId, 'octo/repo')).not.toBe(deriveSeedId('b'.repeat(32), 'octo/repo'));
  });

  it('produces an opaque lowercase hex name with no path separators', () => {
    const seedId = deriveSeedId(runId, 'octo/repo');
    expect(seedId).toMatch(/^[0-9a-f]{32}$/);
    expect(seedId).not.toContain('octo');
  });
});

describe('generateBoundedQueryRunId', () => {
  it('produces a fresh 128-bit hex identifier', () => {
    const first = generateBoundedQueryRunId();
    const second = generateBoundedQueryRunId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(first).not.toBe(second);
  });
});
