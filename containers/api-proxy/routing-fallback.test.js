'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRoutingCatalogue } = require('./routing-catalogue');
const { createRoutingController } = require('./routing-controller');
const { createRoutingError } = require('./routing-errors');
const {
  DEFAULT_TIER_ORDER,
  ROBUST_TIER_ORDER,
  toLookupId,
} = require('./routing-fallback-order');
const { createRoutingProviderExecutor } = require('./routing-provider-executor');
const {
  createProductionRoutingController,
  createProductionRoutingSession,
  createRoutingObserver,
} = require('./routing-runtime');
const { createCopilotAdapter } = require('./providers/copilot');
const { cachedModels } = require('./key-validation');
const { clearRuntimeModels, replaceRuntimeModels } = require('./runtime-model-catalog');

const CONVERSATION = [{ role: 'user', parts: [{ text: 'fix the failing test' }] }];

const VALID_CLASSIFICATION = {
  labels: { task_type: 'fix', scope: 'local', task_complexity: 'medium' },
  mode: 'balanced',
};

function makeCapabilities(models = []) {
  return {
    name: 'gh-aw-router',
    version: '1.0.0',
    routing_profiles: [
      { goal: 'cost', mode: 'economy' },
      { goal: 'cost', mode: 'balanced' },
      { goal: 'cost', mode: 'robust' },
    ],
    execution_catalogue: { models },
  };
}

function makeFakeClock(start = 1_000) {
  let now = start;
  const timers = new Map();
  let nextId = 1;
  return {
    now: () => now,
    setTimer(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { due: now + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    fireNextTimer() {
      let earliestId = null;
      let earliest = null;
      for (const [id, entry] of timers) {
        if (!earliest || entry.due < earliest.due) {
          earliest = entry;
          earliestId = id;
        }
      }
      if (!earliest) return false;
      timers.delete(earliestId);
      now = Math.max(now, earliest.due);
      earliest.callback();
      return true;
    },
    async sleep(delayMs, signal) {
      if (signal?.aborted) throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
      now += Math.max(0, delayMs);
    },
  };
}

const ELIGIBLE_FIXTURE = Object.freeze([
  { id: 'std-dated', efforts: ['low', 'medium', 'high'], protocols: ['responses'], contextWindow: 128_000, tier: 'standard', releaseDate: '2026-10-01' },
  { id: 'prem-dated', efforts: ['low', 'medium', 'high'], protocols: ['responses'], contextWindow: 128_000, tier: 'premium', releaseDate: '2026-10-15' },
  { id: 'light-dated', efforts: ['low', 'medium'], protocols: ['responses'], contextWindow: 128_000, tier: 'lightweight', releaseDate: '2026-11-01' },
  { id: 'other-dated', efforts: ['medium'], protocols: ['responses'], contextWindow: 128_000, tier: 'none', releaseDate: '2026-11-10' },
  { id: 'unclass-dated', efforts: ['low', 'medium'], protocols: ['responses'], contextWindow: 128_000, tier: undefined, releaseDate: '2026-11-05' },
  { id: 'std-undated', efforts: ['medium'], protocols: ['responses'], contextWindow: 128_000, tier: 'standard', releaseDate: undefined },
  { id: 'claude-effortless', efforts: [], protocols: ['chat-completions'], contextWindow: 200_000, tier: 'lightweight', releaseDate: '2025-10-15' },
  { id: 'alpha-no-medium', efforts: ['low', 'high'], protocols: ['responses'], contextWindow: 128_000, tier: 'standard', releaseDate: '2026-10-01' },
]);

const INELIGIBLE_FIXTURE = Object.freeze([
  { id: 'inelig-decisions', efforts: [], protocols: ['decisions'], supportedEndpoints: ['/v1/decisions'] },
  { id: 'inelig-hidden', efforts: ['medium'], protocols: ['responses'], modelPickerEnabled: false, supportedEndpoints: ['/responses'] },
  { id: 'inelig-embedding', efforts: ['medium'], protocols: ['responses'], capabilities: { type: 'embeddings' }, supportedEndpoints: ['/responses'] },
  { id: 'inelig-no-tools', efforts: ['medium'], protocols: ['responses'], capabilities: { type: 'chat', supports: { tool_calls: false } }, supportedEndpoints: ['/responses'] },
  { id: 'inelig-native-glob', efforts: ['medium'], protocols: ['chat-completions', 'responses'], familyPatternEndpointsOnly: true },
]);

const INELIGIBLE_IDS = new Set(INELIGIBLE_FIXTURE.map(model => model.id));

const FIXTURE_TIERS = Object.freeze(
  Object.fromEntries(
    ELIGIBLE_FIXTURE
      .filter(model => model.tier !== undefined || model.releaseDate !== undefined)
      .map(model => [
        toLookupId(model.id, 'copilot'),
        {
          ...(model.tier !== undefined ? { tier: model.tier } : {}),
          ...(model.releaseDate !== undefined ? { releaseDate: model.releaseDate } : {}),
        },
      ]),
  ),
);

function expectedFallbackSequence(subset, mode) {
  const tierOrder = mode === 'robust' ? ROBUST_TIER_ORDER : DEFAULT_TIER_ORDER;
  const tierRank = new Map(tierOrder.map((tier, index) => [tier, index]));
  const ladder = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const med = ladder.indexOf('medium');
  const pickEffort = efforts => {
    if (efforts.length === 0) return undefined;
    if (efforts.includes('medium')) return 'medium';
    return [...efforts].sort((a, b) => {
      const da = Math.abs(ladder.indexOf(a) - med);
      const db = Math.abs(ladder.indexOf(b) - med);
      if (da !== db) return da - db;
      return ladder.indexOf(b) - ladder.indexOf(a);
    })[0];
  };
  return [...subset]
    .map(model => ({
      id: model.id,
      tier: model.tier ?? 'unclassified',
      releaseDate: model.releaseDate ?? null,
      effort: pickEffort(model.efforts),
    }))
    .sort((left, right) => {
      const tierDiff = tierRank.get(left.tier) - tierRank.get(right.tier);
      if (tierDiff !== 0) return tierDiff;
      if (left.releaseDate !== right.releaseDate) {
        if (left.releaseDate === null) return 1;
        if (right.releaseDate === null) return -1;
        return left.releaseDate > right.releaseDate ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
}

function makePlanner(behavior, clock) {
  const base = {
    health: async () => 204,
    capabilities: async () => makeCapabilities([]),
    classify: async request => ({
      system_prompt: 'classify',
      prompt: 'task',
      ranked_choices: request.models.slice(0, 1).map(choice => ({ ...choice })),
    }),
    route: async request => {
      const eligible = request.models.filter(choice => !INELIGIBLE_IDS.has(choice.model.split('/')[1]));
      if (eligible.length === 0) {
        throw Object.assign(new Error('no route'), { statusCode: 422, body: { code: 'no_route' } });
      }
      // Prefer the last offered eligible choice so the router's preference differs from fallback order.
      const reversed = eligible.slice().reverse().map(({ id, model, effort }) => ({
        id,
        model,
        ...(effort === undefined ? {} : { effort }),
      }));
      return { ranked_choices: reversed };
    },
  };
  if (behavior === 'valid_rank') return base;
  if (behavior === 'no_route') {
    return {
      ...base,
      route: async () => {
        throw Object.assign(new Error('no route'), { statusCode: 422, body: { code: 'no_route' } });
      },
    };
  }
  if (behavior === 'unhealthy') {
    return {
      ...base,
      health: async () => {
        throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      },
    };
  }
  if (behavior === 'invalid_answer') {
    return {
      ...base,
      route: async () => ({ ranked_choices: [{ id: 'bogus', model: 'github-copilot/bogus' }] }),
    };
  }
  if (behavior === 'timeout') {
    return {
      ...base,
      health: ({ signal }) => new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', transient: true })), { once: true });
        queueMicrotask(() => clock.fireNextTimer());
      }),
    };
  }
  throw new Error(`Unknown behavior: ${behavior}`);
}

describe('routing controller fallback guarantee', () => {
  it('satisfies the guarantee across all 256 subsets, ineligible models, router behaviors, and per-model vetoes', async () => {
    const behaviors = ['valid_rank', 'no_route', 'unhealthy', 'invalid_answer', 'timeout'];
    const totalSubsets = 1 << ELIGIBLE_FIXTURE.length;

    for (let mask = 0; mask < totalSubsets; mask++) {
      const subset = ELIGIBLE_FIXTURE.filter((_, bit) => (mask & (1 << bit)) !== 0);
      const allModels = [...INELIGIBLE_FIXTURE, ...subset];
      const mode = mask % 2 === 0 ? 'balanced' : 'robust';
      const expectedOrder = expectedFallbackSequence(subset, mode);

      for (const behavior of behaviors) {
        // Test unvetoed, plus vetoing the expected winner (when non-empty), plus vetoing all models on small masks.
        const vetoSets = [new Set()];
        if (expectedOrder.length > 0) {
          vetoSets.push(new Set([expectedOrder[0].id]));
        }
        if (subset.length > 0 && subset.length <= 2) {
          vetoSets.push(new Set(subset.map(model => model.id)));
        }

        for (const vetoed of vetoSets) {
          const triedChoiceIds = [];
          const records = [];
          const clock = makeFakeClock(10_000);
          const controller = createRoutingController({
            config: {
              provider: 'copilot',
              objective: { goal: 'cost', mode },
              task: { conversationFile: '/tmp/conversation.json' },
            },
            planner: makePlanner(behavior, clock),
            catalogue: {
              getSnapshot: async () => ({
                provider: 'copilot',
                configured: true,
                discovery: 'complete',
                models: allModels,
              }),
            },
            loadConversation: async () => CONVERSATION,
            executor: {
              execute: async () => ({
                statusCode: 200,
                body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(VALID_CLASSIFICATION) }), 'utf8'),
              }),
              checkBeforePrimary: async ({ selection }) => {
                triedChoiceIds.push(selection.choice.id);
                if (vetoed.has(selection.wire_model)) {
                  throw createRoutingError('model_multiplier_cap_exceeded', `capped: ${selection.wire_model}`);
                }
              },
            },
            observer: { record: record => records.push(record) },
            clock,
            random: () => 0,
            codingTiers: FIXTURE_TIERS,
          });

          const result = await controller.run({ jobDeadlineMs: 10_000 + 2_000 });
          const passingModels = expectedOrder.filter(entry => !vetoed.has(entry.id));

          // No choice is ever tried twice.
          expect(new Set(triedChoiceIds).size).toBe(triedChoiceIds.length);

          if (passingModels.length === 0) {
            expect(result.ok).toBe(false);
          } else {
            expect(result.ok).toBe(true);
            expect(INELIGIBLE_IDS.has(result.selection.wire_model)).toBe(false);

            const selectionRecord = records.find(record => record.stage === 'selection');
            expect(selectionRecord).toBeDefined();

            if (behavior === 'valid_rank') {
              // Router ranked all eligible choices in reverse pool order; first passing router choice wins.
              expect(result.selection.selection_source).toBe('router');
              expect(result.selection.fallback_reason).toBeNull();
              expect(result.selection.fallback_tier).toBeNull();
              expect(selectionRecord.selection_source).toBe('router');
              expect(selectionRecord.fallback_reason).toBeNull();
              expect(selectionRecord.fallback_tier).toBeNull();
            } else {
              const expectedWinner = passingModels[0];
              expect(result.selection.wire_model).toBe(expectedWinner.id);
              expect(result.selection.choice.effort).toBe(expectedWinner.effort);
              expect(result.selection.selection_source).toBe('fallback');
              expect(result.selection.fallback_tier).toBe(expectedWinner.tier);
              expect(result.selection.fallback_reason).toBeTruthy();
              expect(selectionRecord.selection_source).toBe('fallback');
              expect(selectionRecord.fallback_tier).toBe(expectedWinner.tier);
              expect(selectionRecord.ranked_choices).toBeNull();
              if (behavior === 'unhealthy' || behavior === 'timeout') {
                expect(selectionRecord.router).toBeNull();
              }
            }
          }
        }
      }
    }
  });

  it('vetoes every model in turn under every router behavior and selects the next passing choice', async () => {
    const behaviors = ['valid_rank', 'no_route', 'unhealthy', 'invalid_answer', 'timeout'];
    for (const mode of ['balanced', 'robust']) {
      const expectedOrder = expectedFallbackSequence(ELIGIBLE_FIXTURE, mode);
      for (const behavior of behaviors) {
        for (const vetoedModel of ELIGIBLE_FIXTURE) {
          const triedChoiceIds = [];
          const clock = makeFakeClock(10_000);
          const controller = createRoutingController({
            config: {
              provider: 'copilot',
              objective: { goal: 'cost', mode },
              task: { conversationFile: '/tmp/conversation.json' },
            },
            planner: makePlanner(behavior, clock),
            catalogue: {
              getSnapshot: async () => ({
                provider: 'copilot',
                configured: true,
                discovery: 'complete',
                models: [...INELIGIBLE_FIXTURE, ...ELIGIBLE_FIXTURE],
              }),
            },
            loadConversation: async () => CONVERSATION,
            executor: {
              execute: async () => ({
                statusCode: 200,
                body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(VALID_CLASSIFICATION) }), 'utf8'),
              }),
              checkBeforePrimary: async ({ selection }) => {
                triedChoiceIds.push(selection.choice.id);
                if (selection.wire_model === vetoedModel.id) {
                  throw createRoutingError('pricing_resolution_error', `unpriced: ${selection.wire_model}`);
                }
              },
            },
            observer: { record: () => {} },
            clock,
            random: () => 0,
            codingTiers: FIXTURE_TIERS,
          });

          const result = await controller.run({ jobDeadlineMs: 12_000 });
          expect(result.ok).toBe(true);
          expect(result.selection.wire_model).not.toBe(vetoedModel.id);
          expect(INELIGIBLE_IDS.has(result.selection.wire_model)).toBe(false);
          expect(new Set(triedChoiceIds).size).toBe(triedChoiceIds.length);
          if (behavior !== 'valid_rank') {
            const expectedWinner = expectedOrder.find(entry => entry.id !== vetoedModel.id);
            expect(result.selection.wire_model).toBe(expectedWinner.id);
            expect(result.selection.choice.effort).toBe(expectedWinner.effort);
            expect(result.selection.fallback_tier).toBe(expectedWinner.tier);
          }
        }
      }
    }
  });

  it('falls back to the remaining pool when every router-ranked choice is vetoed by a per-model guard', async () => {
    const tried = [];
    const records = [];
    const controller = createRoutingController({
      config: {
        provider: 'copilot',
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/tmp/conversation.json' },
      },
      planner: {
        ...makePlanner('valid_rank'),
        route: async request => {
          const capped = request.models.find(choice => choice.model === 'github-copilot/prem-dated');
          return { ranked_choices: [{ id: capped.id, model: capped.model, effort: capped.effort }] };
        },
      },
      catalogue: {
        getSnapshot: async () => ({
          provider: 'copilot',
          configured: true,
          discovery: 'complete',
          models: ELIGIBLE_FIXTURE.slice(0, 3),
        }),
      },
      loadConversation: async () => CONVERSATION,
      executor: {
        execute: async () => ({
          statusCode: 200,
          body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(VALID_CLASSIFICATION) }), 'utf8'),
        }),
        checkBeforePrimary: async ({ selection }) => {
          tried.push(selection.choice.id);
          if (selection.wire_model === 'prem-dated') {
            throw createRoutingError('model_multiplier_cap_exceeded', 'capped');
          }
        },
      },
      observer: { record: record => records.push(record) },
      codingTiers: FIXTURE_TIERS,
    });

    const result = await controller.run();
    expect(result.ok).toBe(true);
    expect(result.selection).toMatchObject({
      wire_model: 'std-dated',
      choice: { model: 'github-copilot/std-dated', effort: 'medium' },
      selection_source: 'fallback',
      fallback_reason: 'model_multiplier_cap_exceeded',
      fallback_tier: 'standard',
    });
    expect(new Set(tried).size).toBe(tried.length);
  });

  test.each([
    'ai_credits_limit_exceeded',
    'max_runs_exceeded',
    'max_cache_misses_exceeded',
    'permission_denied_limit_exceeded',
  ])('still stops immediately on run-wide guard %s', async guardCode => {
    const checked = [];
    const controller = createRoutingController({
      config: {
        provider: 'copilot',
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/tmp/conversation.json' },
      },
      planner: makePlanner('no_route'),
      catalogue: {
        getSnapshot: async () => ({
          provider: 'copilot',
          configured: true,
          discovery: 'complete',
          models: ELIGIBLE_FIXTURE.slice(0, 3),
        }),
      },
      loadConversation: async () => CONVERSATION,
      executor: {
        execute: async () => ({
          statusCode: 200,
          body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(VALID_CLASSIFICATION) }), 'utf8'),
        }),
        checkBeforePrimary: async ({ selection }) => {
          checked.push(selection.wire_model);
          throw createRoutingError(guardCode, 'run-wide stop');
        },
      },
      observer: { record: () => {} },
      codingTiers: FIXTURE_TIERS,
    });

    const result = await controller.run();
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe(guardCode);
    expect(checked).toHaveLength(1);
  });

  it('still stops on cancellation and on an already-expired overall deadline', async () => {
    const abortController = new AbortController();
    abortController.abort();
    const cancelled = createRoutingController({
      config: {
        provider: 'copilot',
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/tmp/conversation.json' },
      },
      planner: makePlanner('no_route'),
      catalogue: {
        getSnapshot: async () => ({
          provider: 'copilot',
          configured: true,
          discovery: 'complete',
          models: ELIGIBLE_FIXTURE.slice(0, 2),
        }),
      },
      loadConversation: async () => CONVERSATION,
      executor: { execute: async () => ({ statusCode: 200, body: Buffer.from('{}') }), checkBeforePrimary: async () => {} },
      observer: { record: () => {} },
      codingTiers: FIXTURE_TIERS,
    });
    await expect(cancelled.run({ signal: abortController.signal }))
      .resolves.toMatchObject({ ok: false, failure: { code: 'routing_cancelled' } });

    const expired = createRoutingController({
      config: {
        provider: 'copilot',
        objective: { goal: 'cost', mode: 'balanced' },
        task: { conversationFile: '/tmp/conversation.json' },
      },
      planner: makePlanner('no_route'),
      catalogue: {
        getSnapshot: async () => ({
          provider: 'copilot',
          configured: true,
          discovery: 'complete',
          models: ELIGIBLE_FIXTURE.slice(0, 2),
        }),
      },
      loadConversation: async () => CONVERSATION,
      executor: { execute: async () => ({ statusCode: 200, body: Buffer.from('{}') }), checkBeforePrimary: async () => {} },
      observer: { record: () => {} },
      clock: { now: () => 5_000, setTimer: setTimeout, clearTimer: clearTimeout, sleep: async () => {} },
      codingTiers: FIXTURE_TIERS,
    });
    await expect(expired.run({ jobDeadlineMs: 4_000 }))
      .resolves.toMatchObject({ ok: false, failure: { code: 'routing_timeout' } });
  });
});

describe('named fallback fixtures', () => {
  // Exact 21 Copilot models observed in IntelliTect/EssentialCSharp.Web run 43091701270 (gh-aw#76961).
  const ISSUE_76961_MODELS = Object.freeze([
    {
      id: 'claude-haiku-4.5',
      modelPickerEnabled: true,
      supportedEndpoints: ['/chat/completions', '/v1/messages'],
      supportedReasoningEfforts: [],
      capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_context_window_tokens: 200_000 } },
    },
    ...['gpt-3.5-turbo', 'gpt-3.5-turbo-0613', 'gpt-4', 'gpt-4-0613', 'gpt-4-o-preview',
      'gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-41-copilot', 'gpt-4o', 'gpt-4o-2024-05-13',
      'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18'].map(id => ({
      id,
      modelPickerEnabled: false,
      supportedEndpoints: [],
      supportedReasoningEfforts: [],
      capabilities: { type: 'chat', limits: { max_context_window_tokens: 128_000 } },
    })),
    {
      id: 'gpt-5.3-codex',
      modelPickerEnabled: true,
      supportedEndpoints: ['/responses', 'ws:/responses'],
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_context_window_tokens: 400_000 } },
    },
    {
      id: 'gpt-5.6-luna-utility',
      modelPickerEnabled: false,
      supportedEndpoints: ['/responses', 'ws:/responses'],
      supportedReasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      capabilities: { type: 'chat', limits: { max_context_window_tokens: 1_050_000 } },
    },
    {
      id: 'gpt-6-luna-decisions',
      modelPickerEnabled: false,
      supportedEndpoints: ['/v1/decisions'],
      supportedReasoningEfforts: [],
      capabilities: { type: 'chat', limits: { max_context_window_tokens: 1_000_000 } },
    },
    ...['text-embedding-3-small', 'text-embedding-3-small-inference', 'text-embedding-ada-002'].map(id => ({
      id,
      modelPickerEnabled: false,
      supportedEndpoints: [],
      supportedReasoningEfforts: [],
      capabilities: { type: 'embeddings' },
    })),
  ]);

  it('selects gpt-5.3-codex at medium on the #76961 21-model catalogue, then claude-haiku-4.5 with no effort when capped', async () => {
    expect(ISSUE_76961_MODELS).toHaveLength(21);
    const catalogue = createRoutingCatalogue({
      getCopilotAdapter: () => createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' }),
      getDiscoveredModels: () => ISSUE_76961_MODELS.map(model => model.id),
      getRuntimeModels: () => ISSUE_76961_MODELS,
    });

    const runWithEnv = async extraEnv => {
      const env = jest.replaceProperty(process, 'env', { ...process.env, ...extraEnv });
      try {
        const executor = createRoutingProviderExecutor({
          getAdapter: () => createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' }),
          proxyRequest: jest.fn(),
          checkRateLimit: jest.fn(),
        });
        const records = [];
        const controller = createRoutingController({
          config: {
            provider: 'copilot',
            objective: { goal: 'cost', mode: 'balanced' },
            task: { conversationFile: '/tmp/conversation.json' },
          },
          planner: makePlanner('no_route'),
          catalogue,
          loadConversation: async () => CONVERSATION,
          executor: {
            execute: async () => ({
              statusCode: 200,
              body: Buffer.from(JSON.stringify({ output_text: JSON.stringify(VALID_CLASSIFICATION) }), 'utf8'),
            }),
            checkBeforePrimary: executor.checkBeforePrimary,
          },
          observer: { record: record => records.push(record) },
        });
        const result = await controller.run();
        return { result, records };
      } finally {
        env.restore();
      }
    };

    const first = await runWithEnv({});
    expect(first.result.ok).toBe(true);
    expect(first.result.selection).toMatchObject({
      wire_model: 'gpt-5.3-codex',
      choice: { model: 'github-copilot/gpt-5.3-codex', effort: 'medium' },
      endpoint: '/responses',
      selection_source: 'fallback',
      fallback_reason: 'no_route',
      fallback_tier: 'standard',
    });

    const capped = await runWithEnv({
      AWF_MAX_MODEL_MULTIPLIER: '1',
      AWF_DEFAULT_MODEL_MULTIPLIER: '1',
      AWF_MODEL_MULTIPLIERS: JSON.stringify({ 'gpt-5.3-codex': 2 }),
    });
    expect(capped.result.ok).toBe(true);
    expect(capped.result.selection).toMatchObject({
      wire_model: 'claude-haiku-4.5',
      choice: { model: 'github-copilot/claude-haiku-4.5' },
      endpoint: '/chat/completions',
      selection_source: 'fallback',
      fallback_reason: 'no_route',
      fallback_tier: 'lightweight',
    });
    expect(Object.hasOwn(capped.result.selection.choice, 'effort')).toBe(false);
  });

  it('never picks gpt-4o-transcribe under OpenAI gpt-4o* during fallback', async () => {
    const openaiAdapter = {
      name: 'openai',
      isEnabled: () => true,
      getTargetHost: () => 'api.openai.com',
    };
    const makeOpenAiController = discovered => {
      const catalogue = createRoutingCatalogue({
        getAdapter: provider => provider === 'openai' ? openaiAdapter : null,
        getDiscoveredModels: provider => provider === 'openai' ? discovered : null,
        // Give gpt-4o-transcribe effortless reasoning metadata so it would enter the pool via gpt-4o*.
        getRuntimeModels: () => [{ id: 'gpt-4o-transcribe', supportedReasoningEfforts: [] }],
      });
      return createRoutingController({
        config: {
          provider: 'openai',
          objective: { goal: 'cost', mode: 'balanced' },
          task: { conversationFile: '/tmp/conversation.json' },
        },
        planner: makePlanner('no_route'),
        catalogue,
        loadConversation: async () => CONVERSATION,
        executor: { execute: async () => ({ statusCode: 200, body: Buffer.from('{}') }), checkBeforePrimary: async () => {} },
        observer: { record: () => {} },
      });
    };

    const paired = await makeOpenAiController(['gpt-4o-transcribe', 'gpt-5.4']).run();
    expect(paired.ok).toBe(true);
    expect(paired.selection).toMatchObject({
      provider: 'openai',
      wire_model: 'gpt-5.4',
      choice: { model: 'openai/gpt-5.4', effort: 'medium' },
      selection_source: 'fallback',
      fallback_tier: 'unclassified',
    });

    const alone = await makeOpenAiController(['gpt-4o-transcribe']).run();
    expect(alone.ok).toBe(false);
    expect(alone.failure.code).toBe('no_route');
  });

  it('picks GPT-6.2 Sol over GPT-6.2 Astra on the same release date, or Astra at robust', async () => {
    const models = [
      { id: 'gpt-6.2-astra', efforts: ['low', 'medium', 'high'], protocols: ['responses'], contextWindow: 1_050_000 },
      { id: 'gpt-6.2-sol', efforts: ['low', 'medium', 'high'], protocols: ['responses'], contextWindow: 1_050_000 },
    ];
    const runMode = async (mode, classifiedMode = 'balanced') => {
      const controller = createRoutingController({
        config: {
          provider: 'copilot',
          objective: { goal: 'cost', mode },
          task: { conversationFile: '/tmp/conversation.json' },
        },
        planner: makePlanner('no_route'),
        catalogue: { getSnapshot: async () => ({ provider: 'copilot', configured: true, discovery: 'complete', models }) },
        loadConversation: async () => CONVERSATION,
        executor: {
          execute: async () => ({
            statusCode: 200,
            body: Buffer.from(JSON.stringify({
              output_text: JSON.stringify({ ...VALID_CLASSIFICATION, mode: classifiedMode }),
            }), 'utf8'),
          }),
          checkBeforePrimary: async () => {},
        },
        observer: { record: () => {} },
      });
      return controller.run();
    };

    const balanced = await runMode('balanced');
    expect(balanced.selection).toMatchObject({
      wire_model: 'gpt-6.2-sol',
      choice: { effort: 'medium' },
      selection_source: 'fallback',
      fallback_tier: 'standard',
    });

    const robust = await runMode('robust');
    expect(robust.selection).toMatchObject({
      wire_model: 'gpt-6.2-astra',
      choice: { effort: 'medium' },
      selection_source: 'fallback',
      fallback_tier: 'premium',
    });

    const autoRobust = await runMode('auto', 'robust');
    expect(autoRobust.selection).toMatchObject({
      wire_model: 'gpt-6.2-astra',
      choice: { effort: 'medium' },
      selection_source: 'fallback',
      fallback_tier: 'premium',
    });
  });
});

describe('startup with a router that never becomes healthy', () => {
  let tempDir;
  let savedLogDir;
  let savedCachedCopilot;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-unhealthy-router-'));
    savedLogDir = process.env.AWF_TOKEN_LOG_DIR;
    savedCachedCopilot = cachedModels.copilot;
    process.env.AWF_TOKEN_LOG_DIR = tempDir;
  });

  afterEach(() => {
    if (savedLogDir === undefined) delete process.env.AWF_TOKEN_LOG_DIR;
    else process.env.AWF_TOKEN_LOG_DIR = savedLogDir;
    cachedModels.copilot = savedCachedCopilot;
    clearRuntimeModels();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a recorded fallback selection before the deadline without making any model call', async () => {
    const inputDir = path.join(tempDir, 'input');
    const outputDir = path.join(tempDir, 'output');
    fs.mkdirSync(inputDir);
    fs.mkdirSync(outputDir);
    const conversationFile = path.join(inputDir, 'conversation.json');
    fs.writeFileSync(conversationFile, JSON.stringify(CONVERSATION));

    cachedModels.copilot = ['claude-haiku-4.5', 'gpt-5.3-codex'];
    replaceRuntimeModels('copilot', [
      {
        id: 'claude-haiku-4.5',
        modelPickerEnabled: true,
        supportedEndpoints: ['/chat/completions'],
        supportedReasoningEfforts: [],
        capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_context_window_tokens: 200_000 } },
      },
      {
        id: 'gpt-5.3-codex',
        modelPickerEnabled: true,
        supportedEndpoints: ['/responses'],
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        capabilities: { type: 'chat', supports: { tool_calls: true }, limits: { max_context_window_tokens: 400_000 } },
      },
    ]);

    const rawConfig = JSON.stringify({
      provider: 'copilot',
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile },
    });

    const http = require('http');
    let routerRequests = 0;
    const unhealthyServer = http.createServer((_req, res) => {
      routerRequests++;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":"starting"}');
    });
    await new Promise(resolve => unhealthyServer.listen(0, '127.0.0.1', resolve));
    const { port } = unhealthyServer.address();

    try {
      const adapter = createCopilotAdapter({ COPILOT_GITHUB_TOKEN: 'test-token' });
      const routerTransport = {
        request: (options, callback) => http.request(
          { ...options, hostname: '127.0.0.1', port },
          callback,
        ),
      };

      const observer = createRoutingObserver(jest.fn());
      const started = Date.now();
      const session = createProductionRoutingSession({
        rawConfig,
        getAdapter: provider => provider === 'copilot' ? adapter : null,
        outputDir,
        observer,
        createController: args => createProductionRoutingController({
          ...args,
          routerTransport,
          random: () => 0,
        }),
      });

      const result = await session.start();
      const elapsedMs = Date.now() - started;

      expect(result.ok).toBe(true);
      expect(elapsedMs).toBeLessThan(10_000);
      expect(routerRequests).toBeGreaterThanOrEqual(1);

      const selectionFile = JSON.parse(fs.readFileSync(path.join(outputDir, 'selection.json'), 'utf8'));
      expect(selectionFile).toMatchObject({
        schema: 'awf-routing-selection/v1',
        provider: 'copilot',
        wire_model: 'gpt-5.3-codex',
        choice: { model: 'github-copilot/gpt-5.3-codex', effort: 'medium' },
        endpoint: '/responses',
        selection_source: 'fallback',
        fallback_reason: 'router_unavailable',
        fallback_tier: 'standard',
      });

      const logRecords = fs.readFileSync(path.join(tempDir, 'model-routing.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      // No classification stage means zero model calls were made while deciding.
      expect(logRecords.filter(record => record.stage === 'classification')).toHaveLength(0);
      const selectionLog = logRecords.find(record => record.stage === 'selection');
      expect(selectionLog).toMatchObject({
        stage: 'selection',
        wire_model: 'gpt-5.3-codex',
        selected_model: 'github-copilot/gpt-5.3-codex',
        selected_effort: 'medium',
        selection_source: 'fallback',
        fallback_reason: 'router_unavailable',
        fallback_tier: 'standard',
        router: null,
        ranked_choices: null,
        classifier_attempts: 0,
      });
    } finally {
      await new Promise(resolve => unhealthyServer.close(resolve));
    }
  });
});
