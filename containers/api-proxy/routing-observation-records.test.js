'use strict';

const { createHash } = require('crypto');
const { recordClassifierAttempt, recordSelection, recordFailure } = require('./routing-observation-records');
const { createRoutingError, toRoutingFailure } = require('./routing-errors');

const conversation = [{ role: 'user', parts: [{ text: 'private task' }] }];
const choice = { id: 'choice-0001', model: 'github-copilot/gpt-test' };
const context = {
  config: { objective: { goal: 'cost', mode: 'balanced' } },
  selection: { provider: 'copilot', wire_model: 'gpt-test', endpoint: '/responses', choice },
  classification: null, successfulClassifier: null,
  rawCapabilities: { name: 'router', version: '1.0.0' },
  route: { ranked_choices: [choice] }, conversation,
  degradedReason: 'classifier_attempts_exhausted', actualAttempts: 2,
  pool: { choices: [choice] }, catalogueOverlap: 0, clock: { now: () => 150 }, startedAt: 100,
};

describe('routing observation records', () => {
  it('keeps degraded selection fields explicit and hashes rather than records conversation text', () => {
    const observer = { record: jest.fn() };
    recordSelection(observer, context);
    expect(observer.record).toHaveBeenCalledWith({
      stage: 'selection', objective: context.config.objective, provider: 'copilot', selected_provider: 'copilot',
      wire_model: 'gpt-test', endpoint: '/responses',
      selection_source: 'router', fallback_reason: null, fallback_tier: null,
      labels: null, mode: null,
      classifier_model: null, classifier_effort: null, router: context.rawCapabilities,
      ranked_choices: [{ model: choice.model, effort: null }],
      conversation_sha256: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'),
      selected_id: choice.id, selected_model: choice.model, selected_effort: null,
      degraded_classification: true, degraded_reason: 'classifier_attempts_exhausted', classifier_attempts: 2,
      eligible_choices: 1, catalogue_overlap: 0, latency_ms: 50,
    });
    const record = observer.record.mock.calls[0][0];
    expect(Object.isFrozen(record)).toBe(true);
    expect(JSON.stringify(record)).not.toContain('private task');
  });

  it('records the successful classifier separately from the selected model', () => {
    const observer = { record: jest.fn() };
    const classification = { labels: { task_type: 'implement' }, mode: 'balanced' };
    recordSelection(observer, {
      ...context, classification, successfulClassifier: { model: 'github-copilot/classifier', effort: 'high' },
      degradedReason: null,
    });
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({
      labels: classification.labels, mode: 'balanced',
      classifier_model: 'github-copilot/classifier', classifier_effort: 'high',
      selected_model: choice.model, degraded_classification: false, degraded_reason: null,
    }));
  });

  it('records a fallback selection without inventing a router name or rank', () => {
    const observer = { record: jest.fn() };
    recordSelection(observer, {
      ...context,
      selection: {
        provider: 'copilot', wire_model: 'gpt-test', endpoint: '/responses', choice,
        selection_source: 'fallback', fallback_reason: 'router_unavailable', fallback_tier: 'standard',
      },
      rawCapabilities: null,
      route: null,
      degradedReason: null,
      actualAttempts: 0,
      catalogueOverlap: null,
    });
    expect(observer.record).toHaveBeenCalledWith(expect.objectContaining({
      stage: 'selection',
      selection_source: 'fallback',
      fallback_reason: 'router_unavailable',
      fallback_tier: 'standard',
      router: null,
      ranked_choices: null,
      classifier_attempts: 0,
      catalogue_overlap: null,
    }));
  });

  it('keeps failure fields and nonnegative latency independent of a selection', () => {
    const observer = { record: jest.fn() };
    const failure = toRoutingFailure(createRoutingError('no_route', 'No eligible model'));
    recordFailure(observer, { failure, catalogueOverlap: null, clock: { now: () => 90 }, startedAt: 100 });
    expect(observer.record).toHaveBeenCalledWith({
      stage: 'failure', objective: null, code: 'no_route', detail: 'No eligible model',
      catalogue_overlap: null, latency_ms: 0,
    });
    expect(Object.isFrozen(observer.record.mock.calls[0][0])).toBe(true);
  });

  it('records classifier attempts without prompts or undefined effort', () => {
    const observer = { record: jest.fn() };
    recordClassifierAttempt(observer, { purpose: 'routing_classification', attempt: 2, mapping: { choice } });
    expect(observer.record).toHaveBeenCalledWith({
      stage: 'classification', purpose: 'routing_classification', attempt: 2,
      classifier_model: choice.model, classifier_effort: null,
    });
    expect(Object.isFrozen(observer.record.mock.calls[0][0])).toBe(true);
  });

  it.each([undefined, {}, { record: () => { throw new Error('unwritable'); } }])(
    'isolates missing or throwing observers from all stages', observer => {
      expect(() => recordClassifierAttempt(observer, { purpose: 'routing_classification', attempt: 1, mapping: { choice } }))
        .not.toThrow();
      expect(() => recordSelection(observer, context)).not.toThrow();
      expect(() => recordFailure(observer, {
        ...context, failure: toRoutingFailure(createRoutingError('no_route', 'No eligible model')),
      })).not.toThrow();
    },
  );
});
