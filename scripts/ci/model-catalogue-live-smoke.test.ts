import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import * as childProcess from 'node:child_process';
import { Script } from 'node:vm';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import { validateWithSchema } from '../../src/schema-validator';

jest.mock('node:child_process', () => ({ spawnSync: jest.fn(), spawn: jest.fn() }));

const {
  RELEASE, config, failureCode, projectCatalogue, waitForCatalogue,
  selectModel, assertAccounting, assertNetwork, publication, inference, bundledPricing,
  downloadRelease, exercise, observeStartup, validateExecutionContext, readExecutionContext,
} = require('./model-catalogue-live-smoke.cjs');

const revision = 'a'.repeat(64);
const sourceCommit = 'b'.repeat(40);
const catalogue = { source: 'github/gh-aw-firewall', state: 'active',
  origin: 'network', revision, sourceCommit, failure: null };
const model = 'claude-haiku-4.5';
const candidate = { models: [model] };
const reflection = {
  model_catalogue: catalogue, models_fetch_complete: true,
  endpoints: [{ provider: 'copilot', configured: true, models: [model], model_metadata: [] }],
};
const record = {
  _schema: `token-usage/v${RELEASE.version}`, provider: 'copilot', model, status: 200,
  input_tokens: 12, output_tokens: 3, ai_credits_this_response: 0.0027,
  ai_credits_pricing_source: 'central_feed', ai_credits_pricing_tier: 'default',
  ai_credits_pricing_catalog_id: catalogue.source,
  ai_credits_pricing_catalog_version: revision, ai_credits_fallback_pricing_used: false,
};
const packet = '12:00:00.000000 veth0 In IP 172.30.0.30.45000 > 172.30.0.10.3128: Flags [S], seq 1, win 1, length 0';
const summary = '1 packets captured\n1 packets received by filter\n0 packets dropped by kernel\n';
const emptySummary = '0 packets captured\n0 packets received by filter\n0 packets dropped by kernel\n';
const denial = '1.000 172.30.0.30:45000 - -:0 1.1 CONNECT 403 TCP_DENIED:HIER_NONE api.github.com:443 "node"';

function executionFixture(branch = 'lpcox-fix-catalogue-smoke-startup', eventName = 'workflow_dispatch') {
  const sha = 'd'.repeat(40);
  const ref = `refs/heads/${branch}`;
  const env: Record<string, string> = {
    GITHUB_ACTIONS: 'true', GITHUB_REF: ref, GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: 'github/gh-aw-firewall', GITHUB_ACTOR: 'reviewer-fixture',
    GITHUB_WORKFLOW_REF: `github/gh-aw-firewall/.github/workflows/smoke-model-catalogue.yml@${ref}`,
    GITHUB_WORKFLOW_SHA: sha,
  };
  const event: {
    ref: string; after?: string; repository: { full_name: string }; sender: { login: string };
    inputs?: { reviewed_head_sha?: unknown };
  } = {
    ref, repository: { full_name: env.GITHUB_REPOSITORY }, sender: { login: env.GITHUB_ACTOR },
    ...(eventName === 'push' ? { after: sha } : { inputs: { reviewed_head_sha: sha } }),
  };
  return { env, event, checkoutSha: sha };
}

describe('released model catalogue smoke', () => {
  it('pins one released binary and all matching infrastructure images', () => {
    expect(RELEASE.version).toBe('0.28.75');
    expect(RELEASE.binarySha256).toBe('796e3c5d46f54f2c2c45a68afbbf5368dd70666341e08052cbefe7d8fd766946');
    for (const reference of Object.values(RELEASE.images)) {
      expect(reference).toMatch(/^ghcr\.io\/github\/gh-aw-firewall\/[\w-]+:0\.28\.75@sha256:[a-f0-9]{64}$/);
    }
    expect(Object.keys(RELEASE.images).sort()).toEqual(['agent', 'apiProxy', 'squid']);
    for (const mode of ['online', 'offline', 'denied']) {
      const value = config(mode);
      expect(validateWithSchema(value)).toEqual([]);
      expect(value.container.images).toEqual(RELEASE.images);
      expect(value.container.buildLocal).toBeUndefined();
      expect(value.network.isolation).toBe(true);
      expect(value.apiProxy.modelCatalogue.cacheDirectory).toBe('/tmp/catalogue-smoke-private');
      expect(value.apiProxy.modelCatalogue.trustSource).toBeUndefined();
      expect(value.apiProxy.maxAiCredits).toBe(1);
      expect(value.apiProxy.maxRuns).toBe(1);
    }
    expect(config('online').network.allowDomains).toEqual(['api.github.com', 'api.githubcopilot.com']);
    expect(config('denied').network.allowDomains).not.toContain('api.github.com');
    expect(config('offline').apiProxy.modelCatalogue.offline).toBe(true);
  });

  it('requires live network activation, not a healthy HTTP 200', async () => {
    await expect(waitForCatalogue(async () => reflection, 'online')).resolves.toMatchObject({ catalogue: { revision } });
    await expect(waitForCatalogue(async () => ({ status: 'healthy' }), 'online')).rejects.toThrow('catalogue_source');
    for (const state of ['fallback_bundled', 'offline_bundled']) {
      await expect(waitForCatalogue(async () => ({
        model_catalogue: { source: catalogue.source, state },
      }), 'online')).rejects.toThrow('catalogue_unexpected_fallback');
    }
    expect(() => projectCatalogue({ ...catalogue, origin: 'cache' })).toThrow('catalogue_origin');
    expect(() => projectCatalogue({ ...catalogue, source: 'operator:arbitrary' })).toThrow('catalogue_source');
  });

  it('times out bounded readiness including pending catalogue or unavailable models', async () => {
    for (const value of [null, { model_catalogue: { source: catalogue.source, state: 'pending' } },
      { ...reflection, models_fetch_complete: false }]) {
      let clock = 0;
      await expect(waitForCatalogue(async () => value, 'online', {
        timeoutMs: 500, now: () => clock, delay: async () => { clock += 250; },
      })).rejects.toThrow('catalogue_readiness_timeout');
      expect(clock).toBe(500);
    }
  });

  it('requires fresh explicit offline or network-denial fallback', async () => {
    await expect(waitForCatalogue(async () => ({
      model_catalogue: { source: catalogue.source, state: 'offline_bundled' },
    }), 'offline')).resolves.toBeDefined();
    await expect(waitForCatalogue(async () => ({
      model_catalogue: { source: catalogue.source, state: 'fallback_bundled',
        failure: 'catalogue_invalid_or_unavailable' },
    }), 'denied')).resolves.toBeDefined();
    await expect(waitForCatalogue(async () => reflection, 'offline')).rejects.toThrow();
    await expect(waitForCatalogue(async () => ({
      model_catalogue: { source: catalogue.source, state: 'fallback_bundled',
        failure: 'catalogue_tariff_unsupported' },
    }), 'denied')).rejects.toThrow('denial_failure');
  });

  it('selects only an actually available model with an applicable accepted tariff', () => {
    expect(selectModel(reflection, candidate)).toEqual({ model, expectedSource: 'central_feed' });
    expect(() => selectModel(reflection, { models: ['different-model'] })).toThrow('no_available_reviewed_smoke_model');
    expect(() => selectModel({ ...reflection, endpoints: [] }, candidate)).toThrow('copilot_not_configured');
  });

  it('honors complete fresh provider pricing and labels central accounting unexercised', () => {
    const observed = new Date().toISOString();
    const withProvider = {
      ...reflection,
      endpoints: [{ ...reflection.endpoints[0], model_metadata: [{
        id: model, observed_at: observed,
        pricing: { default: { input: 1, output: 5, cachedInput: 0.1, cacheWrite: 1.25 } },
      }] }],
    };
    const selection = selectModel(withProvider, candidate);
    expect(selection.expectedSource).toBe('provider');
    const providerRecord = { ...record, ai_credits_pricing_source: 'provider',
      ai_credits_pricing_catalog_version: undefined, ai_credits_pricing_observed_at: observed };
    expect(assertAccounting([providerRecord], selection, catalogue).central_accounting)
      .toBe('not_exercised_provider_precedence');
    expect(() => assertAccounting([record], selection, catalogue)).toThrow('accounting_precedence');
    delete (withProvider.endpoints[0].model_metadata[0].pricing.default as Partial<{
      cacheWrite: number;
    }>).cacheWrite;
    expect(selectModel(withProvider, candidate).expectedSource).toBe('central_feed');
  });

  it('requires nonempty bounded usage and the exact pinned central revision', () => {
    const selection = { model, expectedSource: 'central_feed' };
    expect(assertAccounting([record], selection, catalogue).central_accounting).toBe('exercised');
    for (const records of [[], [record, record], [{ ...record, input_tokens: 0 }],
      [{ ...record, output_tokens: 17 }], [{ ...record, ai_credits_this_response: 2 }],
      [{ ...record, ai_credits_pricing_catalog_version: 'c'.repeat(64) }],
      [{ ...record, ai_credits_pricing_source: 'curated' }],
      [{ ...record, _schema: 'token-usage/v0.0.0-dev' }]]) {
      expect(() => assertAccounting(records, selection, catalogue)).toThrow();
    }
  });

  it('proves no offline TCP/feed request and requires an actual Squid denial', () => {
    expect(assertNetwork('offline', '', emptySummary, '').squid_requests).toBe(0);
    expect(assertNetwork('denied', packet, summary, denial).denied_catalogue_requests).toBe(1);
    expect(() => assertNetwork('offline', packet, summary, '')).toThrow('offline_network_attempt');
    expect(() => assertNetwork('offline', '', emptySummary, denial)).toThrow('offline_feed_request');
    expect(() => assertNetwork('denied', '', emptySummary, '')).toThrow('denial_not_observed');
    expect(() => assertNetwork('offline', '', summary, '')).toThrow('network_capture_incomplete');
    expect(() => assertNetwork('denied', packet, summary, denial.replace('api.github.com', 'other.example'))).toThrow('unexpected_catalogue_failover');
    expect(() => assertNetwork('denied', packet.replace('172.30.0.10.3128', '1.1.1.1.443'), summary, denial)).toThrow('unexpected_direct_network_attempt');
    expect(() => assertNetwork('denied', packet, summary.replace('0 packets dropped', '1 packets dropped'), denial)).toThrow('network_capture_dropped');
    expect(() => assertNetwork('denied', packet, '', denial)).toThrow('network_capture_dropped');
  });

  it('never projects arbitrary reflection, accounting, or exception data into evidence', () => {
    const sentinel = 'SECRET_SENTINEL_DO_NOT_UPLOAD';
    const projected = projectCatalogue({ ...catalogue, environment: sentinel,
      endpoints: [{ authorization: sentinel }], unknown: sentinel });
    const accounting = assertAccounting([{ ...record, request: sentinel,
      response: sentinel, authorization: sentinel }], { model, expectedSource: 'central_feed' }, catalogue);
    expect(JSON.stringify({ projected, accounting })).not.toContain(sentinel);
    expect(Object.keys(projected).sort()).toEqual(['origin', 'revision', 'source', 'sourceCommit', 'state']);
    expect(failureCode(new Error(`request failed: ${sentinel}`))).toBe('smoke_operation_failed');
    expect(failureCode(new Error('secretwithoutdelimiters'))).toBe('smoke_operation_failed');
    expect(failureCode(new Error('catalogue_revision_missing'))).toBe('catalogue_revision_missing');
    expect(() => projectCatalogue({ ...catalogue, revision: sentinel })).toThrow();
  });

  it('generates syntactically valid container probes and cross-checks an immutable publication', () => {
    const exec = childProcess.spawnSync as jest.Mock;
    exec.mockImplementation((_command: string, args: string[]) => {
      expect(args.slice(0, 4)).toEqual(['exec', 'proxy-fixture', 'node', '-e']);
      expect(() => new Script(args[4])).not.toThrow();
      expect(args[5]).toBe('publication');
      expect(args[4]).toContain('candidate.dataCommit');
      expect(args[4]).toContain('current.json?ref=\' + sha');
      return { status: 0, stdout: JSON.stringify({ dataCommit: 'c'.repeat(40),
        revision, sourceCommit, models: [model] }) };
    });
    expect(publication('proxy-fixture', catalogue).revision).toBe(revision);
    expect(() => publication('proxy-fixture', { ...catalogue, revision: 'd'.repeat(64) }))
      .toThrow('publication_revision');
  });

  it('performs one bounded inference and reads only projected accounting fields', async () => {
    const exec = childProcess.spawnSync as jest.Mock;
    exec.mockReset();
    exec.mockImplementation((_command: string, args: string[]) => {
      expect(() => new Script(args[4])).not.toThrow();
      if (args[1] === 'agent-fixture') {
        expect(args[5]).toBe('inference');
        expect(JSON.parse(args[6])).toEqual({ model });
        expect(args[4]).toContain('max_tokens: 16, stream: false');
        expect(args[4]).toContain('AbortSignal.timeout(90000)');
        expect(args[4]).toContain('model: params.model');
        return { status: 0, stdout: '' };
      }
      expect(args[5]).toBe('accounting');
      expect(args[4]).toContain('Object.fromEntries');
      return { status: 0, stdout: JSON.stringify([record]) };
    });
    expect((await inference('agent-fixture', 'proxy-fixture',
      { model, expectedSource: 'central_feed' }, catalogue)).central_accounting).toBe('exercised');
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('fails on absent accounting rather than treating inference success as sufficient', async () => {
    jest.useFakeTimers();
    const exec = childProcess.spawnSync as jest.Mock;
    exec.mockImplementation((_command: string, args: string[]) =>
      ({ status: 0, stdout: args[1] === 'agent-fixture' ? '' : '[]' }));
    try {
      const result = expect(inference('agent-fixture', 'proxy-fixture',
        { model, expectedSource: 'central_feed' }, catalogue)).rejects.toThrow('accounting_timeout');
      await jest.advanceTimersByTimeAsync(10000);
      await result;
    } finally {
      jest.useRealTimers();
    }
  });

  it('checks actual released bundled guard behavior, not a fabricated fallback record', () => {
    const exec = childProcess.spawnSync as jest.Mock;
    exec.mockImplementation((_command: string, args: string[]) => {
      expect(() => new Script(args[4])).not.toThrow();
      expect(args[5]).toBe('bundled_pricing');
      expect(args[4]).toContain("require('/app/guards/ai-credits-guard')");
      return { status: 0, stdout: JSON.stringify({ source: 'curated', credits: 0.015 }) };
    });
    expect(bundledPricing('proxy-fixture').credits).toBe(0.015);
    exec.mockReturnValue({ status: 0, stdout: JSON.stringify({ source: 'central_feed', credits: 0.015 }) });
    expect(() => bundledPricing('proxy-fixture')).toThrow('bundled_pricing_changed');
  });

  it('downloads the pinned release to a private path and executes it only after digest verification', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-smoke-download-test-'));
    const binary = path.join(root, 'awf');
    const bytes = Buffer.from('verified release fixture');
    const digest = require('node:crypto').createHash('sha256').update(bytes).digest('hex');
    const execute = jest.fn((_command: string, args: string[]) => {
      fs.writeFileSync(args[args.indexOf('--output') + 1], bytes, { mode: 0o600 });
      return '';
    });
    try {
      downloadRelease(binary, execute, digest);
      expect(execute).toHaveBeenCalledWith('curl', expect.arrayContaining([
        '--proto', '=https', '--output', binary,
        `https://github.com/github/gh-aw-firewall/releases/download/v${RELEASE.version}/awf-linux-x64`,
      ]), { timeout: 130000 });
      expect(fs.statSync(binary).mode & 0o777).toBe(0o700);
      fs.chmodSync(binary, 0o600);
      expect(() => downloadRelease(binary, execute, '0'.repeat(64))).toThrow('release_digest');
      expect(fs.statSync(binary).mode & 0o777).toBe(0o600);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('tears down its Compose services even when the network observer failed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-smoke-test-'));
    const commands: string[][] = [];
    (childProcess.spawnSync as jest.Mock).mockImplementation((_command: string, args: string[]) => {
      commands.push(args);
      if (args[0] === 'exec') return { status: 0, stdout: '{"status":"healthy"}' };
      if (args.includes('api-proxy')) return { status: 0, stdout: 'proxy-fixture' };
      return { status: 0, stdout: '' };
    });
    (childProcess.spawn as jest.Mock).mockImplementation((command: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill: jest.fn(() => { child.emit('close'); }),
      });
      if (command === 'tcpdump') {
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from('listening on any'));
          child.emit('close');
        });
      } else {
        const work = path.join(root, 'offline', 'work');
        expect(fs.statSync(work).mode & 0o777).toBe(0o700);
        expect(fs.lstatSync(work).isDirectory()).toBe(true);
        expect(fs.statSync(work).uid).toBe(process.getuid?.());
        fs.writeFileSync(path.join(work, 'docker-compose.yml'), 'services: {}');
      }
      return child;
    });
    try {
      await expect(exercise('released-awf-fixture', root, 'offline', {})).rejects.toThrow('network_capture_exited');
      expect(commands.some(args => args.includes('down') && args.includes('--volumes'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('precreates every case workdir privately even with the normal permissive umask', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-smoke-startup-test-'));
    const previousUmask = process.umask(0o022);
    const sentinel = 'SECRET_SENTINEL_DO_NOT_UPLOAD';
    (childProcess.spawnSync as jest.Mock).mockReturnValue({ status: 0, stdout: '' });
    (childProcess.spawn as jest.Mock).mockImplementation((command: string, args: string[], options: {
      env: Record<string, string>; stdio: string[];
    }) => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(), stderr: new EventEmitter(),
        kill: jest.fn(() => { child.emit('close', 143, null); }),
      });
      if (command === 'tcpdump') {
        queueMicrotask(() => child.stderr.emit('data', Buffer.from('listening on any')));
      } else {
        const work = args[args.indexOf('--work-dir') + 1];
        expect(fs.statSync(work).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(work)).mode & 0o777).toBe(0o700);
        expect(options.stdio).toEqual(['ignore', 'ignore', 'pipe']);
        if (!work.includes('/online/')) expect(options.env.COPILOT_GITHUB_TOKEN).toBeUndefined();
        queueMicrotask(() => {
          child.stderr.emit('data', Buffer.from(`[INFO] Generating configuration files...\n${sentinel}\n`));
          child.emit('close', 1, null);
        });
      }
      return child;
    });
    try {
      for (const mode of ['online', 'offline', 'denied']) {
        const evidence: { startup?: object } = {};
        await expect(exercise('released-awf-fixture', root, mode, evidence))
          .rejects.toThrow('awf_exited_before_readiness');
        expect(evidence.startup).toEqual({
          state: 'exited', last_stage: 'configuration', reason: 'unknown', exit_code: 1,
        });
        expect(JSON.stringify(evidence)).not.toContain(sentinel);
      }
    } finally {
      process.umask(previousUmask);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects bounded startup classes and exit status without retaining raw diagnostics', () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    const snapshot = observeStartup(child);
    const sentinel = 'SECRET_SENTINEL_DO_NOT_UPLOAD';
    child.stderr.emit('data', Buffer.from('[INFO] Generating configuration files...\n'));
    child.stderr.emit('data', Buffer.from('[ERROR] Fatal error: Error: Refusing to use work directory accessible by group'));
    child.stderr.emit('data', Buffer.from(` or other users: /tmp/${sentinel} (mode=755)\n`));
    child.stderr.emit('data', Buffer.from(sentinel.repeat(1000)));
    child.emit('close', 1, null);
    expect(snapshot()).toEqual({
      state: 'exited', last_stage: 'configuration', reason: 'work_directory_permissions', exit_code: 1,
    });
    expect(JSON.stringify(snapshot())).not.toContain(sentinel);
    expect(snapshot()).not.toHaveProperty('stderr');

    const denied = Object.assign(new EventEmitter(), { stderr: new EventEmitter() });
    const deniedSnapshot = observeStartup(denied);
    denied.stderr.emit('data', Buffer.from(`[INFO] Starting containers...\n[ERROR] unknown ${sentinel}\n`));
    denied.emit('error', { code: sentinel });
    denied.emit('close', null, 'SIGKILL');
    expect(deniedSnapshot()).toEqual({
      state: 'exited', last_stage: 'containers', reason: 'spawn_failed',
      spawn_error: 'other', exit_code: null, signal: 'SIGKILL',
    });
    expect(JSON.stringify(deniedSnapshot())).not.toContain(sentinel);
  });

  it('accepts normal main execution and only the exact reviewed manual repair tuple', () => {
    for (const [branch, eventName] of [['main', 'push'], ['main', 'workflow_dispatch'],
      ['lpcox-fix-catalogue-smoke-startup', 'workflow_dispatch']]) {
      const fixture = executionFixture(branch, eventName);
      if (branch === 'main') delete fixture.event.inputs;
      expect(validateExecutionContext(fixture.env, fixture.event, fixture.checkoutSha)).toEqual({
        mode: branch === 'main' ? 'main' : 'reviewed_repair_branch',
        ref: fixture.env.GITHUB_REF, sha: fixture.env.GITHUB_SHA,
      });
      if (eventName === 'workflow_dispatch') {
        fixture.event.ref = branch;
        expect(validateExecutionContext(fixture.env, fixture.event, fixture.checkoutSha)).toBeDefined();
      }
    }
  });

  const rejectedContexts: Array<[string, (fixture: ReturnType<typeof executionFixture>) => void]> = [
    ['non-Actions execution', fixture => { fixture.env.GITHUB_ACTIONS = 'false'; }],
    ['other branch', fixture => { fixture.env.GITHUB_REF = 'refs/heads/other'; }],
    ['tag', fixture => { fixture.env.GITHUB_REF = 'refs/tags/v0.28.75'; }],
    ['repair push', fixture => { fixture.env.GITHUB_EVENT_NAME = 'push'; }],
    ['PR event', fixture => { fixture.env.GITHUB_EVENT_NAME = 'pull_request'; }],
    ['privileged PR event', fixture => { fixture.env.GITHUB_EVENT_NAME = 'pull_request_target'; }],
    ['workflow run event', fixture => { fixture.env.GITHUB_EVENT_NAME = 'workflow_run'; }],
    ['missing reviewed input', fixture => { delete fixture.event.inputs; }],
    ['empty reviewed input', fixture => { fixture.event.inputs = { reviewed_head_sha: '' }; }],
    ['non-string reviewed input', fixture => { fixture.event.inputs = { reviewed_head_sha: [fixture.checkoutSha] }; }],
    ['abbreviated reviewed input', fixture => { fixture.event.inputs = { reviewed_head_sha: fixture.checkoutSha.slice(0, 7) }; }],
    ['mismatched reviewed input', fixture => { fixture.event.inputs = { reviewed_head_sha: 'e'.repeat(40) }; }],
    ['missing event SHA', fixture => { delete fixture.env.GITHUB_SHA; }],
    ['mismatched event ref', fixture => { fixture.event.ref = 'main'; }],
    ['mismatched repository', fixture => { fixture.event.repository.full_name = 'untrusted/repository'; }],
    ['mismatched environment repository', fixture => { fixture.env.GITHUB_REPOSITORY = 'untrusted/repository'; }],
    ['mismatched event sender', fixture => { fixture.event.sender.login = 'different-fixture'; }],
    ['missing actor', fixture => { delete fixture.env.GITHUB_ACTOR; }],
    ['different launching workflow', fixture => {
      fixture.env.GITHUB_WORKFLOW_REF = `github/gh-aw-firewall/.github/workflows/other.yml@${fixture.env.GITHUB_REF}`;
    }],
    ['mismatched workflow SHA', fixture => { fixture.env.GITHUB_WORKFLOW_SHA = 'e'.repeat(40); }],
    ['mismatched checked-out SHA', fixture => { fixture.checkoutSha = 'e'.repeat(40); }],
  ];
  it.each(rejectedContexts)('rejects %s without default branch authorization', (_label, mutate) => {
    const fixture = executionFixture();
    mutate(fixture);
    expect(() => validateExecutionContext(fixture.env, fixture.event, fixture.checkoutSha)).toThrow();
  });

  it('cross-checks push metadata and rejects mismatched reviewed input on main too', () => {
    const push = executionFixture('main', 'push');
    push.event.after = 'e'.repeat(40);
    expect(() => validateExecutionContext(push.env, push.event, push.checkoutSha)).toThrow('trusted_event_metadata');
    const manual = executionFixture('main');
    manual.event.inputs = { reviewed_head_sha: 'e'.repeat(40) };
    expect(() => validateExecutionContext(manual.env, manual.event, manual.checkoutSha)).toThrow('reviewed_head_sha_mismatch');
  });

  it('reads actual event-file inputs, not a caller-supplied reviewed-SHA environment override', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalogue-smoke-event-test-'));
    const fixture = executionFixture();
    const file = path.join(root, 'event.json');
    fixture.env.GITHUB_EVENT_PATH = file;
    fixture.env.REVIEWED_HEAD_SHA = fixture.checkoutSha;
    (childProcess.spawnSync as jest.Mock).mockReturnValue({ status: 0, stdout: fixture.checkoutSha });
    try {
      fs.writeFileSync(file, JSON.stringify(fixture.event), { mode: 0o600 });
      expect(readExecutionContext(fixture.env).mode).toBe('reviewed_repair_branch');
      delete fixture.event.inputs;
      fs.writeFileSync(file, JSON.stringify(fixture.event));
      expect(() => readExecutionContext(fixture.env)).toThrow('reviewed_head_sha_required');
      expect(() => readExecutionContext({ ...fixture.env, GITHUB_EVENT_PATH: 'relative.json' }))
        .toThrow('trusted_event_metadata');
      fs.writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
      expect(() => readExecutionContext(fixture.env)).toThrow('trusted_event_metadata');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps trusted triggers, exact-SHA checkout, and existing scoped Actions inference credentials', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/smoke-model-catalogue.yml'), 'utf8');
    const workflow = yaml.load(source) as {
      on: Record<string, unknown>;
      permissions: Record<string, string>;
      jobs: { smoke: { if: string; permissions: Record<string, string>; steps: Array<{
        name?: string; uses?: string; env?: Record<string, string>; with?: Record<string, unknown>;
      }> } };
    };
    expect(Object.keys(workflow.on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(workflow.on.push).toMatchObject({ branches: ['main'] });
    expect(workflow.on.workflow_dispatch).toEqual({
      inputs: { reviewed_head_sha: {
        description: 'Exact security-reviewed commit SHA; required for the fixed smoke-repair branch',
        type: 'string', required: false,
      } },
    });
    expect(workflow.jobs.smoke.if).toContain("github.ref == 'refs/heads/lpcox-fix-catalogue-smoke-startup'");
    expect(workflow.jobs.smoke.if).toContain("inputs.reviewed_head_sha != '' && inputs.reviewed_head_sha == github.sha");
    const jobAllowed = (fixture: ReturnType<typeof executionFixture>) => new Script(workflow.jobs.smoke.if)
      .runInNewContext({
        github: { ref: fixture.env.GITHUB_REF, sha: fixture.env.GITHUB_SHA, event_name: fixture.env.GITHUB_EVENT_NAME },
        inputs: { reviewed_head_sha: fixture.event.inputs?.reviewed_head_sha ?? '' },
      });
    expect(jobAllowed(executionFixture())).toBe(true);
    expect(jobAllowed(executionFixture('main', 'push'))).toBe(true);
    const mainManual = executionFixture('main');
    delete mainManual.event.inputs;
    expect(jobAllowed(mainManual)).toBe(true);
    for (const fixture of [executionFixture('other'), executionFixture('lpcox-fix-catalogue-smoke-startup', 'push'),
      executionFixture('lpcox-fix-catalogue-smoke-startup', 'pull_request'),
      executionFixture('lpcox-fix-catalogue-smoke-startup', 'workflow_run')]) {
      expect(jobAllowed(fixture)).toBe(false);
    }
    const missing = executionFixture();
    delete missing.event.inputs;
    expect(jobAllowed(missing)).toBe(false);
    missing.event.inputs = { reviewed_head_sha: 'e'.repeat(40) };
    expect(jobAllowed(missing)).toBe(false);
    const checkout = workflow.jobs.smoke.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('${{ github.sha }}');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.smoke.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    const live = workflow.jobs.smoke.steps.find(step => step.env?.COPILOT_GITHUB_TOKEN);
    expect(live?.env?.COPILOT_GITHUB_TOKEN).toBe('${{ github.token }}');
    const upload = workflow.jobs.smoke.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.path).toBe('${{ runner.temp }}/catalogue-smoke/evidence.json');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('sudo chown "$(id -u):$(id -g)"');
    for (const key of ['GITHUB_SHA', 'GITHUB_WORKFLOW_SHA', 'GITHUB_ACTOR', 'GITHUB_EVENT_PATH']) {
      expect(source).toContain(`${key},`);
    }
    expect(source).not.toMatch(/pull_request|secrets\.|npm (?:ci|install)|build-local|workflow_run/);
  });
});
