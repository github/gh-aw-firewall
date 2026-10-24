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
  downloadRelease, exercise,
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
        fs.mkdirSync(work);
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

  it('uses trusted main-only triggers and existing scoped Actions inference credentials', () => {
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
    expect(workflow.jobs.smoke.if).toBe("github.ref == 'refs/heads/main'");
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.jobs.smoke.permissions).toEqual({ contents: 'read', 'copilot-requests': 'write' });
    const live = workflow.jobs.smoke.steps.find(step => step.env?.COPILOT_GITHUB_TOKEN);
    expect(live?.env?.COPILOT_GITHUB_TOKEN).toBe('${{ github.token }}');
    const upload = workflow.jobs.smoke.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.with?.path).toBe('${{ runner.temp }}/catalogue-smoke/evidence.json');
    expect(source).toContain('persist-credentials: false');
    expect(source).toContain('sudo chown "$(id -u):$(id -g)"');
    expect(source).not.toMatch(/pull_request|secrets\.|npm (?:ci|install)|build-local|workflow_run/);
  });
});
