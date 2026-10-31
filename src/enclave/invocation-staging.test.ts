import * as path from 'path';
import { stageInvocationInputs, invocationFilePath, type InvocationInputPlan } from './invocation-staging';
import { ENCLAVE_RESOURCE_POLICIES, type HostExecutorAgentPolicy } from './execution-policy';

const plan: InvocationInputPlan = {
  invocationHostDir: '/trusted/invocation',
  payload: 'trusted input',
  schema: { type: 'boolean' },
};
const policy: HostExecutorAgentPolicy = { model: 'trusted', profile: 'openai', maxOutputBytes: 4096 };

function dependencies() {
  return {
    writeFile: jest.fn().mockResolvedValue(undefined),
    chmod: jest.fn().mockResolvedValue(undefined),
    chown: jest.fn().mockResolvedValue(undefined),
  };
}

describe('backend-neutral invocation input staging', () => {
  it('stages only the script input with fixed ownership and exclusive creation', async () => {
    const deps = dependencies();
    await stageInvocationInputs(plan, 'script', undefined, deps);
    expect(deps.writeFile).toHaveBeenCalledTimes(1);
    const target = path.join(plan.invocationHostDir, 'request', 'query-script.py');
    expect(deps.writeFile).toHaveBeenCalledWith(target, plan.payload, {
      encoding: 'utf8', mode: 0o400, flag: 'wx',
    });
    expect(deps.chown).toHaveBeenCalledWith(target, ENCLAVE_RESOURCE_POLICIES.script.uid,
      ENCLAVE_RESOURCE_POLICIES.script.gid);
    expect(deps.chmod).toHaveBeenCalledWith(target, 0o400);
  });

  it('stages an agent task, schema, writable session and scoped credential files', async () => {
    const deps = dependencies();
    await stageInvocationInputs(plan, 'agent', {
      ...policy, githubAgentId: 'agent-id', githubBearer: 'invocation-scoped-test-bearer',
    }, deps);
    expect(deps.writeFile.mock.calls.map(([target, contents, options]) => [
      path.relative(plan.invocationHostDir, target), contents, options.mode, options.flag,
    ])).toEqual([
      ['request/task.txt', plan.payload, 0o400, 'wx'],
      ['request/schema.json', JSON.stringify(plan.schema), 0o400, 'wx'],
      ['runtime/session.jsonl', '', 0o600, 'wx'],
      ['session-handoff/github-agent-id', 'agent-id\n', 0o400, 'wx'],
      ['session-handoff/github-bearer', 'invocation-scoped-test-bearer\n', 0o400, 'wx'],
    ]);
    expect(deps.chmod).toHaveBeenCalledTimes(5);
    expect(deps.chown).toHaveBeenCalledTimes(5);
  });

  it('stages only the bearer for a scoped GitHub capability', async () => {
    const deps = dependencies();
    await stageInvocationInputs(plan, 'agent', {
      ...policy, githubBearer: 'scoped-executor-test-bearer',
    }, deps);
    expect(deps.writeFile.mock.calls.map(([target]) => path.relative(plan.invocationHostDir, target)))
      .not.toContain('session-handoff/github-agent-id');
    expect(deps.writeFile.mock.calls.map(([target, contents]) => [
      path.relative(plan.invocationHostDir, target), contents,
    ])).toContainEqual(['session-handoff/github-bearer', 'scoped-executor-test-bearer\n']);
  });

  it('rejects missing agent policy before writing inputs', async () => {
    const deps = dependencies();
    await expect(stageInvocationInputs(plan, 'agent', undefined, deps)).rejects.toThrow(/Trusted agent policy/);
    expect(deps.writeFile).not.toHaveBeenCalled();
  });

  it('rejects host GitHub credentials before writing any invocation inputs', async () => {
    const previous = process.env.GITHUB_PAT;
    const token = 'host-token-for-input-staging-test';
    process.env.GITHUB_PAT = token;
    const deps = dependencies();
    try {
      await expect(stageInvocationInputs(plan, 'agent', {
        ...policy, githubAgentId: 'agent-id', githubBearer: token,
      }, deps)).rejects.toThrow(/host GitHub token/);
      expect(deps.writeFile).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.GITHUB_PAT;
      else process.env.GITHUB_PAT = previous;
    }
  });

  it('does not continue after an exclusive-write failure', async () => {
    const deps = dependencies();
    deps.writeFile.mockRejectedValue(new Error('EEXIST'));
    await expect(stageInvocationInputs(plan, 'agent', policy, deps)).rejects.toThrow('EEXIST');
    expect(deps.chown).not.toHaveBeenCalled();
    expect(deps.chmod).not.toHaveBeenCalled();
  });

  it('rejects paths escaping their designated input directory', () => {
    expect(() => invocationFilePath('/trusted/input', '../outside')).toThrow(/artifact path/);
  });
});
