import * as path from 'path';
import { resolveEnclavePaths } from './paths';
import { assertPrivateRootIsolated } from './mount-policy';
import type { WrapperConfig } from '../types';
import { HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY } from './host-executor-journal';

describe('resolveEnclavePaths', () => {
  it('keeps private state and the gateway capability handoff disjoint', () => {
    const paths = resolveEnclavePaths('/tmp/awf-test', '/private');
    expect(paths.root).toMatch(/^\/private\/awf-enclave-private-/);
    expect(paths.ingressRoot).toMatch(/^\/private\/awf-enclave-control-/);
    expect(paths.ingressRoot).not.toContain(paths.root);
    expect(paths.capabilityPath).toBe(path.join(paths.runDir, 'auth-token'));
    expect(paths.githubAgentIdPath).toBe(path.join(paths.runDir, 'github-agent-id'));
    expect(paths.auditDir.startsWith(paths.root)).toBe(true);
    expect(paths.hostExecutorDir).toBe(path.join(paths.root, 'host-executor'));
    expect(paths.hostExecutorDir.startsWith(`${paths.ingressRoot}/`)).toBe(false);
    expect(paths.hostExecutorJournalDir).toBe(HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY);
    expect(paths.hostExecutorJournalDir.startsWith(`${paths.hostExecutorDir}/`)).toBe(false);
  });

  it('retains one host recovery directory across distinct AWF work directories', () => {
    expect(resolveEnclavePaths('/awf-first', '/private').hostExecutorJournalDir)
      .toBe(resolveEnclavePaths('/awf-second', '/private').hostExecutorJournalDir);
  });

  it('subjects the host socket/capability subtree to the existing primary mount isolation gate', () => {
    const paths = resolveEnclavePaths('/awf-work', '/private');
    const config = {
      workDir: '/awf-work',
      volumeMounts: [`${paths.hostExecutorDir}:/exposed-host-executor:ro`],
    } as WrapperConfig;
    expect(() => assertPrivateRootIsolated(
      config, paths, { GITHUB_WORKSPACE: '/workspace' }, '/workspace',
    )).toThrow(/custom volume/);
  });

  it.each([
    HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY,
    path.dirname(HOST_EXECUTOR_DEFAULT_JOURNAL_DIRECTORY),
  ])('rejects a primary mount exposing global recovery through %s', (source) => {
    const paths = resolveEnclavePaths('/awf-work', '/private');
    const config = { workDir: '/awf-work', volumeMounts: [`${source}:/exposed-journal:rw`] } as WrapperConfig;
    expect(() => assertPrivateRootIsolated(config, {
      root: paths.hostExecutorJournalDir,
      ingressRoot: paths.ingressRoot,
    }, { GITHUB_WORKSPACE: '/workspace' }, '/workspace', 'enclave recovery journal')).toThrow(/custom volume/);
  });
});
