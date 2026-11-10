import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WrapperConfig } from '../types';
import {
  assertRoutingStateNotExportedToGuest,
  cleanupRoutingState,
  MODEL_ROUTING_BACKEND_PARITY_URL,
  pathsOverlap,
  routingBootstrapTestHelpers,
  RoutingFailureExitError,
  stageRoutingConversation,
  verifyRoutingCompletion,
  waitForRoutingSelection,
} from './bootstrap';

// eslint-disable-next-line @typescript-eslint/no-require-imports
jest.mock('execa', () => require('../test-helpers/mock-execa.test-utils').execaMockFactory());

const digest = 'a'.repeat(64);
const originalPlatform = process.platform;

function makeConfig(workDir: string, conversationFile: string): WrapperConfig {
  return {
    allowedDomains: ['github.com'],
    agentCommand: 'echo ok',
    logLevel: 'info',
    keepContainers: false,
    workDir,
    buildLocal: false,
    imageRegistry: 'ghcr.io/github/gh-aw-firewall',
    imageTag: 'latest',
    enableApiProxy: true,
    experimentalModelRouting: true,
    images: {
      router: `ghcr.io/example/router:test@sha256:${digest}`,
    },
    modelRouting: {
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile },
    },
  };
}

function writeConversation(filename: string): void {
  fs.writeFileSync(filename, JSON.stringify([
    { role: 'user', parts: [{ text: 'please fix the tests' }] },
  ]));
}

describe('routing bootstrap', () => {
  let tempDir: string;

  beforeAll(() => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
  });

  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not stage routing without both opt-in and a routing request', () => {
    const config = makeConfig(path.join(tempDir, 'work'), path.join(tempDir, 'missing.json'));
    for (const optIn of [undefined, false]) {
      config.experimentalModelRouting = optIn;
      expect(stageRoutingConversation(config)).toBeUndefined();
      expect(config.modelRoutingBootstrap).toBeUndefined();
    }
    config.experimentalModelRouting = true;
    delete config.modelRouting;
    expect(stageRoutingConversation(config)).toBeUndefined();
    expect(config.modelRoutingBootstrap).toBeUndefined();
  });

  it('validates and stages one private conversation copy with rewritten config', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = makeConfig(path.join(tempDir, 'work'), conversationFile);

    const state = stageRoutingConversation(config)!;

    expect(state.inputFile).toBe(path.join(state.inputDir, 'conversation.json'));
    expect(config.modelRouting?.task.conversationFile).toBe('/run/awf-routing/input/conversation.json');
    expect(config.modelRoutingBootstrap).toBe(state);
    expect(JSON.parse(fs.readFileSync(state.inputFile, 'utf8'))).toEqual([
      { role: 'user', parts: [{ text: 'please fix the tests' }] },
    ]);
    expect(fs.statSync(state.inputFile).mode & 0o777).toBe(0o600);
    expect(state.root.startsWith(os.homedir())).toBe(true);

    cleanupRoutingState(config);
    expect(fs.existsSync(state.root)).toBe(false);
  });

  it('refuses oversized and invalid conversations with public messages', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    fs.writeFileSync(conversationFile, '{');
    const config = makeConfig(path.join(tempDir, 'work'), conversationFile);

    expect(() => stageRoutingConversation(config)).toThrow('The routing conversation is invalid');

    fs.writeFileSync(conversationFile, Buffer.alloc(1_048_577, 65));
    expect(() => stageRoutingConversation(config)).toThrow('The routing conversation exceeds 1048576 bytes');
  });

  it('refuses an unpinned default router image before staging', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = makeConfig(path.join(tempDir, 'work'), conversationFile);
    delete config.images;

    expect(() => stageRoutingConversation(config)).toThrow(
      'Model routing requires container.images.router to be pinned by digest',
    );
    expect(config.modelRoutingBootstrap).toBeUndefined();
  });

  it('accepts a router built from the checkout with --build-local without a digest pin', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = { ...makeConfig(path.join(tempDir, 'work'), conversationFile), buildLocal: true };
    delete config.images;

    const state = stageRoutingConversation(config)!;

    expect(config.modelRoutingBootstrap).toBe(state);
    cleanupRoutingState(config);
  });

  it('refuses routing with preserved containers before staging', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = { ...makeConfig(path.join(tempDir, 'work'), conversationFile), keepContainers: true };

    expect(() => stageRoutingConversation(config)).toThrow(
      'Model routing is not supported with --keep-containers',
    );
    expect(config.modelRoutingBootstrap).toBeUndefined();
  });

  it.each([undefined, '', 'runc', 'cloud-hypervisor'])('admits routing with the %p container runtime', runtime => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = { ...makeConfig(path.join(tempDir, 'work'), conversationFile), containerRuntime: runtime };

    const state = stageRoutingConversation(config)!;

    expect(config.modelRoutingBootstrap).toBe(state);
    cleanupRoutingState(config);
  });

  it.each(['nvx', 'sbx', 'gvisor', 'runsc', 'kata'])(
    'rejects routing with the unsupported %s runtime before staging, naming it and linking backend parity',
    runtime => {
      const conversationFile = path.join(tempDir, 'conversation.json');
      writeConversation(conversationFile);
      const config = { ...makeConfig(path.join(tempDir, 'work'), conversationFile), containerRuntime: runtime };

      expect(() => stageRoutingConversation(config)).toThrow(
        `Model routing is not supported with the "${runtime}" container runtime`,
      );
      expect(() => stageRoutingConversation(config)).toThrow(MODEL_ROUTING_BACKEND_PARITY_URL);
      expect(MODEL_ROUTING_BACKEND_PARITY_URL).toBe('https://github.com/github/gh-aw-firewall/issues/10335');
      expect(config.modelRoutingBootstrap).toBeUndefined();
      expect(fs.existsSync(routingBootstrapTestHelpers.routingRootForWorkDir(config.workDir))).toBe(false);
    },
  );

  it('keeps the remaining host restrictions for cloud-hypervisor routing', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const base = {
      ...makeConfig(path.join(tempDir, 'work'), conversationFile),
      containerRuntime: 'cloud-hypervisor',
    };

    expect(() => stageRoutingConversation({ ...base, keepContainers: true }))
      .toThrow('Model routing is not supported with --keep-containers');
    expect(() => stageRoutingConversation({ ...base, enableApiProxy: false }))
      .toThrow('Model routing requires apiProxy.enabled');
    expect(() => stageRoutingConversation({ ...base, enableDind: true }))
      .toThrow('Model routing is not supported with Docker-in-Docker');
    expect(() => stageRoutingConversation({ ...base, dockerHostPathPrefix: '/host' }))
      .toThrow('Model routing is not supported with split runner/Docker filesystems');
    expect(() => stageRoutingConversation({ ...base, images: undefined }))
      .toThrow('Model routing requires container.images.router to be pinned by digest');
  });

  it('rejects guest exports that would expose private routing state', () => {
    const conversationFile = path.join(tempDir, 'conversation.json');
    writeConversation(conversationFile);
    const config = {
      ...makeConfig(path.join(tempDir, 'work'), conversationFile),
      containerRuntime: 'cloud-hypervisor',
    };
    expect(() => assertRoutingStateNotExportedToGuest(config, [
      { tag: 'workspace', source: os.homedir() },
    ])).not.toThrow();

    const state = stageRoutingConversation(config)!;
    try {
      for (const source of [os.homedir(), state.root, state.inputDir, state.outputDir]) {
        expect(() => assertRoutingStateNotExportedToGuest(config, [
          { tag: 'workspace', source: tempDir },
          { tag: 'tmp-gh-aw', source },
        ])).toThrow('Model routing private state overlaps guest export "tmp-gh-aw"');
      }
      expect(() => assertRoutingStateNotExportedToGuest(config, [
        { tag: 'workspace', source: tempDir },
        { tag: 'sibling', source: `${state.root}-sibling` },
      ])).not.toThrow();
    } finally {
      cleanupRoutingState(config);
    }
  });

  it('waits for a valid selection and reports routing failures with exit 78', async () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    const state = {
      root: tempDir,
      inputDir: path.join(tempDir, 'input'),
      outputDir,
      inputFile: path.join(tempDir, 'input/conversation.json'),
      containerInputFile: '/run/awf-routing/input/conversation.json',
      containerOutputDir: '/run/awf-routing/output',
    };
    fs.writeFileSync(path.join(outputDir, 'selection.json'), JSON.stringify({
      schema: 'awf-routing-selection/v1',
      engine: 'copilot',
      provider: 'copilot',
      choice: { id: 'one', model: 'copilot/gpt-5', effort: 'medium' },
      wire_model: 'gpt-5',
    }));

    await expect(waitForRoutingSelection(state, 1)).resolves.toBeUndefined();

    fs.unlinkSync(path.join(outputDir, 'selection.json'));
    fs.writeFileSync(path.join(outputDir, 'failure.json'), JSON.stringify({
      schema: 'awf-routing-failure/v1',
      code: 'no_route',
      detail: 'No eligible route',
      retryable: false,
    }));

    await expect(waitForRoutingSelection(state, 1)).rejects.toMatchObject({
      exitCode: 78,
      message: 'Model routing failed (no_route): No eligible route',
    });
  });

  it('requires selection and completion records for a clean routed run', () => {
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(outputDir);
    const state = {
      root: tempDir,
      inputDir: path.join(tempDir, 'input'),
      outputDir,
      inputFile: path.join(tempDir, 'input/conversation.json'),
      containerInputFile: '/run/awf-routing/input/conversation.json',
      containerOutputDir: '/run/awf-routing/output',
    };
    fs.writeFileSync(path.join(outputDir, 'selection.json'), JSON.stringify({
      schema: 'awf-routing-selection/v1',
      engine: 'copilot',
      provider: 'copilot',
      choice: { id: 'one', model: 'copilot/gpt-5', effort: 'medium' },
      wire_model: 'gpt-5',
    }));

    expect(() => verifyRoutingCompletion(state)).toThrow(RoutingFailureExitError);
    fs.writeFileSync(path.join(outputDir, 'complete.json'), JSON.stringify({
      schema: 'awf-routing-complete/v1',
    }));
    expect(() => verifyRoutingCompletion(state)).not.toThrow();
  });

  it('keeps result-file validation helpers closed to malformed records', () => {
    expect(routingBootstrapTestHelpers.isSelectionRecord({ schema: 'awf-routing-selection/v1' })).toBe(false);
    expect(routingBootstrapTestHelpers.isFailureRecord({ schema: 'awf-routing-failure/v1' })).toBe(false);
  });

  it.each(['copilot', 'openai', 'anthropic'])('accepts a routing selection for %s', provider => {
    expect(routingBootstrapTestHelpers.isSelectionRecord({
      schema: 'awf-routing-selection/v1',
      engine: 'copilot',
      provider,
      choice: { id: 'one', model: `${provider}/model` },
      wire_model: 'model',
    })).toBe(true);
  });

  it('rejects a selection for a provider outside the supported routing set', () => {
    expect(routingBootstrapTestHelpers.isSelectionRecord({
      schema: 'awf-routing-selection/v1',
      engine: 'copilot',
      provider: 'gemini',
      choice: { id: 'one', model: 'gemini/model' },
      wire_model: 'model',
    })).toBe(false);
  });
});

describe('pathsOverlap', () => {
  it.each([
    ['/a', '/a', true],
    ['/a', '/a/b', true],
    ['/a/b', '/a', true],
    ['/a', '/a/..logs', true],
    ['/a', '/a/...', true],
    ['/a', '/ab', false],
    ['/a/b', '/a/c', false],
    ['/a', '/b/..a', false],
  ])('%s and %s overlap: %s', (left, right, expected) => {
    expect(pathsOverlap(left, right)).toBe(expected);
  });
});
