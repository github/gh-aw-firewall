'use strict';

/**
 * End-to-end coverage for routed reasoning efforts across the routing boundary:
 * catalogue → candidate pool → router selection → published selection →
 * /reflect state → per-request routing observation.
 *
 * Guards the full Copilot effort set, in particular explicit `none` and `max`,
 * so a future change cannot silently drop or alter them before the selected
 * request reaches the provider.
 */

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRoutingController } = require('./routing-controller');
const { createProductionRoutingSession } = require('./routing-runtime');

const CONVERSATION = [{ role: 'user', parts: [{ text: 'add a test' }] }];

const DEFAULT_MODELS = [
  { id: 'gpt-test', efforts: ['none', 'low', 'max'], protocols: ['responses'] },
  { id: 'chat-test', efforts: [], protocols: ['chat-completions'] },
];

function capabilities() {
  return {
    name: 'gh-aw-router',
    version: '1.0.0',
    routing_profiles: [{ goal: 'cost', mode: 'balanced' }],
    execution_catalogue: { models: [] },
  };
}

function copyChoice(choice) {
  const copy = { id: choice.id, model: choice.model };
  if (Object.hasOwn(choice, 'effort')) copy.effort = choice.effort;
  return copy;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.writableFinished = false;
  }

  write() {
    return true;
  }

  end() {
    this.writableFinished = true;
    this.emit('finish');
    return this;
  }
}

/**
 * Run a routed session with a real controller and candidate pool. The router
 * picks whichever offered choice `pick` returns, or `pick` may return a
 * fabricated choice to exercise contract rejection.
 */
async function runRoutedSession({ models = DEFAULT_MODELS, pick }) {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-efforts-'));
  const records = [];
  const routed = [];
  const observer = { record: record => records.push(record) };
  const createController = () => createRoutingController({
    config: {
      provider: 'copilot',
      objective: { goal: 'cost', mode: 'balanced' },
      task: { conversationFile: '/tmp/conversation.json' },
    },
    planner: {
      health: async () => 204,
      capabilities: async () => capabilities(),
      classify: async request => ({
        system_prompt: 'classify the task',
        prompt: 'add a test',
        ranked_choices: request.models.map(copyChoice),
      }),
      route: async request => {
        routed.push(request.models.map(copyChoice));
        return { ranked_choices: [pick(request.models.map(copyChoice))] };
      },
    },
    catalogue: {
      getSnapshot: async () => ({ provider: 'copilot', configured: true, discovery: 'complete', models }),
    },
    loadConversation: async () => JSON.parse(JSON.stringify(CONVERSATION)),
    executor: { execute: jest.fn(), checkBeforePrimary: async () => undefined },
    observer,
  });
  const session = createProductionRoutingSession({ rawConfig: '{}', outputDir, createController, observer });
  const result = await session.start();
  return { session, result, records, routed, outputDir };
}

function readResult(outputDir, name) {
  return JSON.parse(fs.readFileSync(path.join(outputDir, name), 'utf8'));
}

function sendRequest(session, records, url, payload) {
  const req = { method: 'POST', url, headers: {} };
  session.observeRequest(req, new FakeResponse(), { name: 'copilot' });
  expect(req.awfRouting.bodyTransform(Buffer.from(JSON.stringify(payload), 'utf8'))).toBeNull();
  return records.filter(record => record.stage === 'request').at(-1);
}

const byEffort = effort => choices => choices.find(choice =>
  effort === undefined ? !Object.hasOwn(choice, 'effort') : choice.effort === effort);

describe('routed reasoning efforts', () => {
  it('offers explicit none and max, and keeps an omitted effort distinct from none', async () => {
    const { routed } = await runRoutedSession({ pick: byEffort('none') });
    expect(routed[0]).toEqual([
      { id: 'choice-0001', model: 'github-copilot/chat-test' },
      { id: 'choice-0002', model: 'github-copilot/gpt-test', effort: 'low' },
      { id: 'choice-0003', model: 'github-copilot/gpt-test', effort: 'max' },
      { id: 'choice-0004', model: 'github-copilot/gpt-test', effort: 'none' },
    ]);
  });

  it('offers the full Copilot effort set', async () => {
    const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const { routed } = await runRoutedSession({
      models: [{ id: 'gpt-test', efforts, protocols: ['responses'] }],
      pick: byEffort('max'),
    });
    expect(routed[0].map(choice => choice.effort).sort()).toEqual([...efforts].sort());
  });

  describe.each(['none', 'max'])('selected effort %s', effort => {
    it('is published, reflected, and accepted only on the matching model, endpoint, and effort', async () => {
      const { session, result, records, outputDir } = await runRoutedSession({ pick: byEffort(effort) });

      expect(result.ok).toBe(true);
      const selection = {
        schema: 'awf-routing-selection/v1',
        engine: 'copilot',
        provider: 'copilot',
        choice: { id: expect.any(String), model: 'github-copilot/gpt-test', effort },
        wire_model: 'gpt-test',
        endpoint: '/responses',
      };
      expect(result.selection).toEqual(selection);
      expect(readResult(outputDir, 'selection.json')).toEqual(selection);
      expect(records.find(record => record.stage === 'selection')).toMatchObject({ selected_effort: effort });

      expect(session.getReflectState()).toEqual({
        status: 'selected',
        selection: {
          provider: 'copilot',
          model: 'github-copilot/gpt-test',
          wire_model: 'gpt-test',
          effort,
          endpoint: '/responses',
        },
      });

      expect(sendRequest(session, records, '/responses', { model: 'gpt-test', reasoning: { effort } }))
        .toMatchObject({
          routed: 'as_selected',
          deviations: [],
          requested_effort: effort,
          selected_effort: effort,
          selected_endpoint: '/responses',
        });
      expect(sendRequest(session, records, '/v1/responses', { model: 'copilot/gpt-test', reasoning: { effort } }))
        .toMatchObject({ routed: 'as_selected', deviations: [] });

      const otherEffort = effort === 'none' ? 'max' : 'none';
      for (const [url, payload, deviations] of [
        ['/responses', { model: 'gpt-test', reasoning: { effort: otherEffort } }, ['effort']],
        ['/responses', { model: 'gpt-test', reasoning: { effort: 'low' } }, ['effort']],
        ['/responses', { model: 'gpt-test' }, ['effort']],
        ['/responses', { model: 'other-model', reasoning: { effort } }, ['model']],
        ['/chat/completions', { model: 'gpt-test', reasoning_effort: effort }, ['endpoint']],
        ['/chat/completions', { model: 'gpt-test', reasoning: { effort } }, ['effort', 'endpoint']],
      ]) {
        expect(sendRequest(session, records, url, payload)).toMatchObject({
          routed: 'deviated',
          deviations,
          selected_effort: effort,
        });
      }
    });
  });

  it('keeps an omitted selected effort distinct from explicit none', async () => {
    const { session, result, records, outputDir } = await runRoutedSession({ pick: byEffort(undefined) });

    expect(result.ok).toBe(true);
    expect(Object.hasOwn(result.selection.choice, 'effort')).toBe(false);
    expect(Object.hasOwn(readResult(outputDir, 'selection.json').choice, 'effort')).toBe(false);
    expect(records.find(record => record.stage === 'selection')).toMatchObject({ selected_effort: null });
    expect(session.getReflectState().selection).toMatchObject({
      model: 'github-copilot/chat-test',
      effort: null,
      endpoint: '/chat/completions',
    });

    expect(sendRequest(session, records, '/chat/completions', { model: 'chat-test' }))
      .toMatchObject({ routed: 'as_selected', requested_effort: null, selected_effort: null });
    expect(sendRequest(session, records, '/chat/completions', { model: 'chat-test', reasoning_effort: 'none' }))
      .toMatchObject({ routed: 'deviated', deviations: ['effort'], requested_effort: 'none' });

    const none = await runRoutedSession({ pick: byEffort('none') });
    expect(sendRequest(none.session, none.records, '/responses', { model: 'gpt-test' }))
      .toMatchObject({ routed: 'deviated', deviations: ['effort'], requested_effort: null, selected_effort: 'none' });
  });

  it.each([
    ['an unsupported effort', { id: 'choice-0003', model: 'github-copilot/gpt-test', effort: 'ultra' }],
    ['a mismatched effort for an offered id', { id: 'choice-0003', model: 'github-copilot/gpt-test', effort: 'none' }],
    ['a null effort', { id: 'choice-0004', model: 'github-copilot/gpt-test', effort: null }],
    ['an omitted effort where none was offered', { id: 'choice-0004', model: 'github-copilot/gpt-test' }],
    ['an explicit none where the effort was omitted', { id: 'choice-0001', model: 'github-copilot/chat-test', effort: 'none' }],
  ])('fails closed when the router returns %s', async (_name, choice) => {
    const { session, result, outputDir } = await runRoutedSession({ pick: () => choice });
    expect(result.ok).toBe(false);
    expect(result.failure.code).toBe('routing_contract_error');
    expect(fs.existsSync(path.join(outputDir, 'selection.json'))).toBe(false);
    expect(readResult(outputDir, 'failure.json')).toMatchObject({ code: 'routing_contract_error' });
    expect(session.getReflectState()).toEqual({
      status: 'failed',
      failure_code: 'routing_contract_error',
      selection: null,
    });
  });

  it('excludes unsupported catalogue efforts and fails closed when none remain', async () => {
    const mixed = await runRoutedSession({
      models: [{ id: 'gpt-test', efforts: ['ultra', 'max', 'NONE'], protocols: ['responses'] }],
      pick: choices => choices[0],
    });
    expect(mixed.routed[0]).toEqual([{ id: 'choice-0001', model: 'github-copilot/gpt-test', effort: 'max' }]);
    expect(mixed.session.getReflectState().selection).toMatchObject({ effort: 'max', endpoint: '/responses' });

    const unsupported = await runRoutedSession({
      models: [{ id: 'gpt-test', efforts: ['ultra'], protocols: ['responses'] }],
      pick: choices => choices[0],
    });
    expect(unsupported.routed).toEqual([]);
    expect(unsupported.result.failure.code).toBe('no_route');
    expect(unsupported.session.getReflectState()).toEqual({ status: 'failed', failure_code: 'no_route', selection: null });
  });
});
