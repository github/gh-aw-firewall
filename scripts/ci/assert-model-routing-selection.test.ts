import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const {
  assertModelRoutingRecords,
  parseArgs,
  runCli,
} = require('./assert-model-routing-selection.cjs');
const { recordSelection } = require('../../containers/api-proxy/routing-observation-records.js');
const { writeRoutingRecord } = require('../../containers/api-proxy/routing-persistence.js');

const REPO_ROOT = path.resolve(__dirname, '../..');

interface WorkflowStep {
  name: string;
  run?: string;
}

interface WorkflowDocument {
  on: {
    push: {
      paths: string[];
    };
  };
  jobs: Record<string, {
    steps: WorkflowStep[];
  }>;
}

function makeRecord(overrides: Record<string, unknown> = {}) {
  return {
    _schema: 'model-routing/v1',
    event: 'model_routing',
    timestamp: '2026-11-27T18:00:00.000Z',
    stage: 'selection',
    selected_provider: 'copilot',
    selected_model: 'github-copilot/claude-haiku-5.5',
    wire_model: 'claude-haiku-5.5',
    endpoint: '/chat/completions',
    selected_effort: 'low',
    selection_source: 'router',
    fallback_reason: null,
    fallback_tier: null,
    router: { name: 'gh-aw-router', version: '0.4.0' },
    ranked_choices: [{ model: 'github-copilot/claude-haiku-5.5', effort: 'low' }],
    classifier_attempts: 1,
    ...overrides,
  };
}

function makeFallbackSelection(overrides: Record<string, unknown> = {}) {
  return makeRecord({
    selected_model: 'github-copilot/claude-haiku-4.5',
    wire_model: 'claude-haiku-4.5',
    endpoint: '/chat/completions',
    selected_effort: null,
    selection_source: 'fallback',
    fallback_reason: 'no_route',
    fallback_tier: 'lightweight',
    router: { name: 'gh-aw-router', version: '0.4.0' },
    ranked_choices: null,
    classifier_attempts: 0,
    ...overrides,
  });
}

function makeCompletedRequest(overrides: Record<string, unknown> = {}) {
  return {
    _schema: 'model-routing/v1',
    event: 'model_routing',
    timestamp: '2026-11-27T18:00:01.000Z',
    stage: 'request',
    outcome: 'completed',
    status: 200,
    requested_model: 'claude-haiku-4.5',
    selected_model: 'claude-haiku-4.5',
    selected_endpoint: '/chat/completions',
    routed: 'as_selected',
    deviations: [],
    ...overrides,
  };
}

describe('assert-model-routing-selection', () => {
  it('accepts a valid router selection and rejects a silent fallback', () => {
    const selection = assertModelRoutingRecords([makeRecord()], {
      source: 'router',
      provider: 'copilot',
      model: 'github-copilot/claude-haiku-5.5',
      wireModel: 'claude-haiku-5.5',
      forbidText: 'Reply with exactly ROUTED_OK.',
    });
    expect(selection.selection_source).toBe('router');

    expect(() =>
      assertModelRoutingRecords([makeFallbackSelection()], {
        source: 'router',
        provider: 'copilot',
      }),
    ).toThrow(/fallback[\s\S]*router|router[\s\S]*fallback/i);
  });

  it('accepts a healthy-router no_route fallback with completed inference request', () => {
    const selection = assertModelRoutingRecords(
      [makeFallbackSelection(), makeCompletedRequest()],
      {
        source: 'fallback',
        provider: 'copilot',
        model: 'github-copilot/claude-haiku-4.5',
        wireModel: 'claude-haiku-4.5',
        endpoint: '/chat/completions',
        effort: 'null',
        fallbackReason: 'no_route',
        fallbackTier: 'lightweight',
        expectClassifierAttempts: 0,
        expectCompletedRequest: true,
        forbidText: 'Reply with exactly FALLBACK_OK.',
      },
    );
    expect(selection.selection_source).toBe('fallback');
    expect(selection.fallback_tier).toBe('lightweight');
  });

  it('rejects malformed fallback records, missing healthy router identity, failures, and prompt leakage', () => {
    expect(() =>
      assertModelRoutingRecords(
        [makeFallbackSelection({ ranked_choices: [{ model: 'github-copilot/claude-haiku-4.5', effort: null }] })],
        { source: 'fallback', fallbackReason: 'no_route', fallbackTier: 'lightweight' },
      ),
    ).toThrow();

    expect(() =>
      assertModelRoutingRecords(
        [makeFallbackSelection({ router: null })],
        { source: 'fallback', fallbackReason: 'no_route', fallbackTier: 'lightweight' },
      ),
    ).toThrow(/router\.name/);

    expect(() =>
      assertModelRoutingRecords(
        [makeFallbackSelection({ fallback_tier: 'unclassified' })],
        { source: 'fallback', fallbackReason: 'no_route', fallbackTier: 'lightweight' },
      ),
    ).toThrow();

    expect(() =>
      assertModelRoutingRecords(
        [
          makeFallbackSelection(),
          {
            _schema: 'model-routing/v1',
            event: 'model_routing',
            timestamp: '2026-11-27T18:00:02.000Z',
            stage: 'failure',
            code: 'no_route',
          },
        ],
        { source: 'fallback', fallbackReason: 'no_route', fallbackTier: 'lightweight' },
      ),
    ).toThrow(/failure/);

    expect(() =>
      assertModelRoutingRecords(
        [makeFallbackSelection({ detail: 'Reply with exactly FALLBACK_OK.' })],
        {
          source: 'fallback',
          fallbackReason: 'no_route',
          fallbackTier: 'lightweight',
          forbidText: 'Reply with exactly FALLBACK_OK.',
        },
      ),
    ).toThrow(/prompt text/);

    expect(() =>
      assertModelRoutingRecords(
        [makeFallbackSelection()],
        {
          source: 'fallback',
          fallbackReason: 'no_route',
          fallbackTier: 'lightweight',
          expectCompletedRequest: true,
        },
      ),
    ).toThrow(/completed inference/);
  });

  it('validates real records persisted by routing-observation-records and routing-persistence', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-assert-'));
    const previousLogDir = process.env.AWF_TOKEN_LOG_DIR;
    process.env.AWF_TOKEN_LOG_DIR = dir;
    try {
      recordSelection(
        { record: (record: unknown) => writeRoutingRecord(record) },
        {
          config: { objective: { goal: 'cost', mode: 'balanced' }, provider: 'copilot' },
          selection: {
            provider: 'copilot',
            choice: { id: 'c1', model: 'github-copilot/claude-haiku-4.5' },
            wire_model: 'claude-haiku-4.5',
            endpoint: '/chat/completions',
            selection_source: 'fallback',
            fallback_reason: 'no_route',
            fallback_tier: 'lightweight',
          },
          classification: null,
          successfulClassifier: null,
          rawCapabilities: { name: 'gh-aw-router', version: '0.4.0' },
          route: null,
          conversation: [{ role: 'user', parts: [{ text: 'Reply with exactly FALLBACK_OK.' }] }],
          degradedReason: null,
          actualAttempts: 0,
          pool: { choices: [{ id: 'c1', model: 'github-copilot/claude-haiku-4.5' }] },
          catalogueOverlap: 0,
          clock: { now: () => 125 },
          startedAt: 100,
        },
      );
      writeRoutingRecord({
        stage: 'request',
        request_id: 'req-1',
        outcome: 'completed',
        status: 200,
        requested_model: 'claude-haiku-4.5',
        selected_model: 'claude-haiku-4.5',
        selected_endpoint: '/chat/completions',
        routed: 'as_selected',
        deviations: [],
      });

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const result = runCli([
          '--file', path.join(dir, 'model-routing.jsonl'),
          '--source', 'fallback',
          '--provider', 'copilot',
          '--model', 'github-copilot/claude-haiku-4.5',
          '--wire-model', 'claude-haiku-4.5',
          '--endpoint', '/chat/completions',
          '--effort', 'null',
          '--fallback-reason', 'no_route',
          '--fallback-tier', 'lightweight',
          '--expect-classifier-attempts', '0',
          '--expect-completed-request',
          '--forbid-text', 'Reply with exactly FALLBACK_OK.',
          '--label', 'FALLBACK_COPILOT_AUDIT',
        ]);
        expect(result.selection_source).toBe('fallback');
        expect(result.router).toEqual({ name: 'gh-aw-router', version: '0.4.0' });
        expect(logSpy).toHaveBeenCalledWith(
          'FALLBACK_COPILOT_AUDIT=passed source=fallback reason=no_route tier=lightweight model=claude-haiku-4.5',
        );
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      if (previousLogDir === undefined) {
        delete process.env.AWF_TOKEN_LOG_DIR;
      } else {
        process.env.AWF_TOKEN_LOG_DIR = previousLogDir;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects unknown CLI arguments and invalid classifier counts', () => {
    expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
    expect(() => parseArgs(['--expect-classifier-attempts', '-1'])).toThrow(/Invalid integer/);
  });

  it('wires fallback and host-side selection_source assertions into test-model-routing.yml', () => {
    const workflow = yaml.load(
      fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/test-model-routing.yml'), 'utf8'),
    ) as WorkflowDocument;

    expect(workflow.on.push.paths).toEqual(
      expect.arrayContaining([
        'containers/api-proxy/automatic-model-eligibility.js',
        'containers/api-proxy/model-information.coding-tiers.generated.json',
        'scripts/ci/assert-model-routing-selection.cjs',
      ]),
    );

    const routingSteps = workflow.jobs['model-routing'].steps;
    const stepByName = (steps: WorkflowStep[], name: string) => {
      const found = steps.find(step => step.name === name);
      if (!found?.run) throw new Error(`Missing step: ${name}`);
      return found.run;
    };

    for (const name of [
      'Run a routed Copilot inference through AWF',
      'Run an effort-routed Copilot inference through AWF',
      'Run the Copilot CLI agent on the routed selection',
    ]) {
      const script = stepByName(routingSteps, name);
      expect(script).toContain('--proxy-logs-dir "${ROUTING_DIR}/logs"');
      expect(script).toContain('assert-model-routing-selection.cjs');
      expect(script).toContain('--source router');
    }

    const multiAssert = stepByName(routingSteps, 'Assert preserved routing selection and terminal request records');
    expect(multiAssert).toContain('assert.equal(selection.selection_source, "router")');
    expect(multiAssert).toContain('assert.equal(selection.fallback_reason, null)');
    expect(multiAssert).toContain('assert.equal(selection.fallback_tier, null)');

    const fallbackScript = stepByName(routingSteps, 'Run a fallback Copilot inference through AWF');
    expect(fallbackScript).toContain('github-copilot/claude-haiku-4.5');
    expect(fallbackScript).toContain('${COPILOT_API_URL}/reflect');
    expect(fallbackScript).toContain('--proxy-logs-dir "${ROUTING_DIR}/logs"');
    expect(fallbackScript).toContain('--source fallback');
    expect(fallbackScript).toContain('--fallback-reason no_route');
    expect(fallbackScript).toContain('--fallback-tier lightweight');
    expect(fallbackScript).toContain('--expect-classifier-attempts 0');
    expect(fallbackScript).toContain('--expect-completed-request');

    const nativeSteps = workflow.jobs['native-provider-routing'].steps;
    const nativeScript = stepByName(nativeSteps, 'Run a routed ${{ matrix.provider }} inference through AWF');
    expect(nativeScript).toContain('--proxy-logs-dir "${ROUTING_DIR}/logs"');
    expect(nativeScript).toContain('assert-model-routing-selection.cjs');
    expect(nativeScript).toContain('--source router');

    // Confirm the fallback model stays absent from every bundled router table and keeps its coding tier.
    const routerTablesDir = path.join(REPO_ROOT, 'containers/router/routing');
    const routerTables = fs.readdirSync(routerTablesDir).filter(file => file.endsWith('.json'));
    expect(routerTables.length).toBeGreaterThan(0);
    for (const file of routerTables) {
      const content = fs.readFileSync(path.join(routerTablesDir, file), 'utf8');
      expect(content).not.toContain('claude-haiku-4.5');
    }

    const codingTiers = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, 'containers/api-proxy/model-information.coding-tiers.generated.json'),
        'utf8',
      ),
    ) as Record<string, { tier: string }>;
    expect(codingTiers['claude-haiku-4-5']?.tier).toBe('lightweight');

    for (const [jobName, job] of Object.entries(workflow.jobs)) {
      for (const step of job.steps) {
        if (!step.run) continue;
        const syntax = spawnSync('bash', ['-n'], { input: step.run, encoding: 'utf8' });
        expect({ job: jobName, step: step.name, status: syntax.status, stderr: syntax.stderr }).toEqual({
          job: jobName,
          step: step.name,
          status: 0,
          stderr: '',
        });
      }
    }
  });
});
