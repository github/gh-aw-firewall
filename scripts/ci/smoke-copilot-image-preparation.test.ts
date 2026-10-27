import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';
import { applyGeneralWorkflowPatches } from './apply-general-workflow-patches';
import { generateDockerCompose } from '../../src/compose-generator';
import { getSafeHostUid, getSafeHostGid } from '../../src/host-identity';
import { applyConfigOptionsInPlaceWithCliPrecedence } from '../../src/config-precedence';
import { baseConfig, mockNetworkConfig } from '../../src/test-helpers/docker-test-fixtures.test-utils';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../../src/test-helpers/mock-execa.test-utils').execaMockFactory());

interface Step {
  name: string;
  run?: string;
  'timeout-minutes'?: number;
}

const root = path.resolve(__dirname, '../..');
const workflowPath = path.join(root, '.github/workflows/smoke-copilot.lock.yml');
const source = fs.readFileSync(path.join(root, '.github/workflows/smoke-copilot.md'), 'utf8');
const frontmatter = yaml.load(source.split('---')[1]) as {
  steps: Step[];
  'timeout-minutes': number;
};
const preparation = frontmatter.steps.find(step => step.name === 'Build local AWF smoke images')!;
const imageArgs = '--image-registry awf-smoke --image-tag "${AWF_SMOKE_IMAGE_TAG:?}" --skip-pull';

describe('Smoke Copilot local image preparation', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-smoke-images-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const runPreparation = (failure = '') => {
    const calls: string[][] = [];
    // Stub Docker at the process boundary; real build commands must never run in this fixture.
    const script = `
docker() {
  printf '%s\\n' "$*" >> "$CALLS"
  case "$*" in *"$FAILURE"*) if [ -n "$FAILURE" ]; then return 7; fi ;; esac
}
${preparation.run}
`;
    const result = spawnSync('bash', ['-c', script], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10000,
      env: {
        PATH: process.env.PATH,
        GITHUB_RUN_ID: '12345',
        GITHUB_RUN_ATTEMPT: '2',
        GITHUB_ENV: path.join(directory, 'env'),
        CALLS: path.join(directory, 'calls'),
        FAILURE: failure,
      },
    });
    if (fs.existsSync(path.join(directory, 'calls'))) {
      for (const call of fs.readFileSync(path.join(directory, 'calls'), 'utf8').trim().split('\n')) {
        calls.push(call.split(' '));
      }
    }
    return { result, calls };
  };

  it('builds the exact Compose contexts, build args, and reusable image references', () => {
    const { result, calls } = runPreparation();
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(fs.readFileSync(path.join(directory, 'env'), 'utf8'))
      .toBe('AWF_SMOKE_IMAGE_TAG=run-12345-2\n');
    const config = {
      ...baseConfig, workDir: directory, enableApiProxy: true, copilotGithubToken: 'fixture',
      imageRegistry: 'awf-smoke', imageTag: 'run-12345-2', skipPull: true,
    };
    const network = { ...mockNetworkConfig, proxyIp: '172.30.0.30' };
    const execution = generateDockerCompose(config, network);
    const localBuild = generateDockerCompose({ ...config, buildLocal: true }, network);
    const roles = [
      ['squid', 'squid-proxy'], ['agent', 'agent'], ['api-proxy', 'api-proxy'],
    ];
    for (const [image, service] of roles) {
      const build = localBuild.services[service].build!;
      expect(build.dockerfile).toBe('Dockerfile');
      expect(path.resolve(root, `containers/${image}`)).toBe(build.context);
      const args = image === 'agent'
        ? ['--build-arg', `USER_UID=${getSafeHostUid()}`, '--build-arg', `USER_GID=${getSafeHostGid()}`]
        : [];
      expect(calls).toContainEqual([
        'build', ...args, '--tag', execution.services[service].image!, `containers/${image}`,
      ]);
      if (image === 'agent') {
        expect(build.args).toEqual({ USER_UID: getSafeHostUid(), USER_GID: getSafeHostGid() });
      }
      expect(calls).toContainEqual(['image', 'inspect', execution.services[service].image!]);
    }
    expect(calls).toHaveLength(6);
    for (const service of Object.values(execution.services)) expect(service.build).toBeUndefined();
  });

  it.each(['build --tag awf-smoke/squid', 'image inspect awf-smoke/agent'])(
    'fails closed before publishing image selection on %s failure', failure => {
      const { result } = runPreparation(failure);
      expect(result.status).toBe(7);
      expect(fs.existsSync(path.join(directory, 'env'))).toBe(false);
    },
  );

  it('overrides compiler release digests instead of selecting published images', () => {
    const options = { imageRegistry: 'awf-smoke', imageTag: 'run-12345-2', skipPull: true };
    applyConfigOptionsInPlaceWithCliPrecedence(options, {
      imageRegistry: 'ghcr.io/github/gh-aw-firewall',
      imageTag: `0.29.0,squid=sha256:${'a'.repeat(64)}`,
    }, name => ['imageRegistry', 'imageTag', 'skipPull'].includes(name));
    expect(options).toEqual({ imageRegistry: 'awf-smoke', imageTag: 'run-12345-2', skipPull: true });
  });

  it('rejects prepared-image workflows without a local CLI install anchor', () => {
    expect(() => applyGeneralWorkflowPatches(
      `      - name: ${preparation.name}\n        run: echo prepare\n`, workflowPath,
    )).toThrow('Smoke Copilot image preparation requires the local AWF install step');
  });

  it('gives preparation its own bounded budget before the unchanged timed execution', () => {
    const lock = yaml.load(fs.readFileSync(workflowPath, 'utf8')) as {
      jobs: { agent: { steps: Step[]; 'timeout-minutes': number } };
    };
    const steps = lock.jobs.agent.steps;
    const prepareIndex = steps.findIndex(step => step.name === preparation.name);
    const executeIndex = steps.findIndex(step => step.name === 'Execute GitHub Copilot CLI');
    expect(prepareIndex).toBeGreaterThan(steps.findIndex(step => step.name === 'Build awf'));
    expect(prepareIndex).toBeLessThan(executeIndex);
    expect(steps[prepareIndex].run).toBe(preparation.run);
    expect(steps[prepareIndex]['timeout-minutes']).toBe(35);
    expect(steps[executeIndex]['timeout-minutes']).toBe(frontmatter['timeout-minutes']);
    expect(frontmatter['timeout-minutes']).toBe(15);
    expect(lock.jobs.agent['timeout-minutes']).toBeGreaterThanOrEqual(50);
    expect(steps[executeIndex].run).toContain(imageArgs);
    expect(steps[executeIndex].run).not.toContain('--build-local');
    expect(steps[executeIndex].run).not.toMatch(/docker (?:build|compose .*build)/);
    expect(applyGeneralWorkflowPatches(fs.readFileSync(workflowPath, 'utf8'), workflowPath).content)
      .toBe(fs.readFileSync(workflowPath, 'utf8'));
  });

  it.each(['--skip-pull', '--image-tag 0.29.0 --skip-pull', '--build-local'])(
    'replaces compiler image selection %s and remains idempotent', flags => {
      const input = `      - name: ${preparation.name}\n        run: echo prepare\n` +
        '      - name: Install AWF binary\n' +
        '        run: bash "${RUNNER_TEMP}/gh-aw/actions/install_awf_binary.sh" v0.29.0 --rootless\n' +
        `      - name: Execute GitHub Copilot CLI\n        run: awf ${flags} -- echo smoke\n`;
      const first = applyGeneralWorkflowPatches(input, workflowPath).content;
      expect(first).toContain(imageArgs);
      expect(first).not.toContain('--build-local');
      expect(applyGeneralWorkflowPatches(first, workflowPath).content).toBe(first);
      const other = applyGeneralWorkflowPatches(input, '/tmp/smoke-claude.lock.yml').content;
      expect(other).toContain('--build-local');
      expect(other).not.toContain(imageArgs);
    },
  );
});
