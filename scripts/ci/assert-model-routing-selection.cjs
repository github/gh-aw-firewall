#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const VALID_STAGES = new Set(['classification', 'selection', 'failure', 'request']);

function parseJsonl(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      throw new Error(`Invalid JSONL at line ${index + 1}: ${error.message}`);
    }
  });
}

function assertModelRoutingRecords(records, options) {
  const {
    source,
    provider,
    model,
    wireModel,
    endpoint,
    effort,
    fallbackReason,
    fallbackTier,
    expectClassifierAttempts,
    expectCompletedRequest = false,
    forbidText,
  } = options;

  assert.ok(source === 'router' || source === 'fallback', `Unsupported --source value: ${source}`);
  assert.ok(Array.isArray(records) && records.length > 0, 'model-routing.jsonl contained no records');

  for (const record of records) {
    assert.match(record._schema, /^model-routing\/v.+$/);
    assert.equal(record.event, 'model_routing');
    assert.ok(VALID_STAGES.has(record.stage), `Unexpected routing record stage: ${record.stage}`);
    assert.ok(Number.isFinite(Date.parse(record.timestamp)), `Invalid timestamp: ${record.timestamp}`);
    if (forbidText) {
      assert.ok(!JSON.stringify(record).includes(forbidText), 'routing audit captured prompt text');
    }
  }

  assert.ok(!records.some(record => record.stage === 'failure'), 'routing audit recorded a failure');

  const selections = records.filter(record => record.stage === 'selection');
  assert.equal(selections.length, 1, `expected exactly one selection record, found ${selections.length}`);
  const selection = selections[0];

  if (provider !== undefined) {
    assert.equal(selection.selected_provider, provider);
  }
  if (model !== undefined) {
    assert.equal(selection.selected_model, model);
  }
  if (wireModel !== undefined) {
    assert.equal(selection.wire_model, wireModel);
  }
  if (endpoint !== undefined) {
    assert.equal(selection.endpoint, endpoint);
  }
  if (effort !== undefined) {
    const expectedEffort = effort === 'null' ? null : effort;
    assert.equal(selection.selected_effort, expectedEffort);
  }

  if (source === 'router') {
    assert.equal(selection.selection_source, 'router');
    assert.equal(selection.fallback_reason, null);
    assert.equal(selection.fallback_tier, null);
    assert.equal(typeof selection.router?.name, 'string', 'router.name must be a string');
    assert.ok(selection.router.name.length > 0, 'router.name must be non-empty');
    assert.equal(typeof selection.router?.version, 'string', 'router.version must be a string');
    assert.ok(selection.router.version.length > 0, 'router.version must be non-empty');
    assert.ok(
      Array.isArray(selection.ranked_choices) && selection.ranked_choices.length > 0,
      'router selection must include non-empty ranked_choices',
    );
    assert.ok(
      selection.ranked_choices.some(choice => choice.model === selection.selected_model),
      `selected_model ${selection.selected_model} was not in ranked_choices`,
    );
  } else {
    assert.equal(selection.selection_source, 'fallback');
    assert.ok(typeof fallbackReason === 'string' && fallbackReason.length > 0, '--fallback-reason is required for fallback');
    assert.ok(typeof fallbackTier === 'string' && fallbackTier.length > 0, '--fallback-tier is required for fallback');
    assert.equal(selection.fallback_reason, fallbackReason);
    assert.equal(selection.fallback_tier, fallbackTier);
    assert.equal(selection.ranked_choices, null);
    if (fallbackReason === 'no_route') {
      assert.equal(typeof selection.router?.name, 'string', 'healthy router fallback must preserve router.name');
      assert.ok(selection.router.name.length > 0, 'router.name must be non-empty');
      assert.equal(typeof selection.router?.version, 'string', 'healthy router fallback must preserve router.version');
      assert.ok(selection.router.version.length > 0, 'router.version must be non-empty');
    }
  }

  if (expectClassifierAttempts !== undefined) {
    assert.equal(selection.classifier_attempts, expectClassifierAttempts);
  }

  if (expectCompletedRequest) {
    const completed = records.filter(record => record.stage === 'request' && record.outcome === 'completed');
    assert.ok(completed.length >= 1, 'expected at least one completed inference request record');
    const request = completed[0];
    assert.equal(request.status, 200);
    assert.equal(request.requested_model, selection.wire_model);
    assert.equal(request.selected_model, selection.wire_model);
    assert.equal(request.selected_endpoint, selection.endpoint);
    assert.equal(request.routed, 'as_selected');
    assert.deepEqual(request.deviations, []);
  }

  return selection;
}

function parseArgs(argv) {
  const options = {};
  const valueFlags = {
    '--file': 'file',
    '--source': 'source',
    '--provider': 'provider',
    '--model': 'model',
    '--wire-model': 'wireModel',
    '--endpoint': 'endpoint',
    '--effort': 'effort',
    '--fallback-reason': 'fallbackReason',
    '--fallback-tier': 'fallbackTier',
    '--expect-classifier-attempts': 'expectClassifierAttempts',
    '--forbid-text': 'forbidText',
    '--label': 'label',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--expect-completed-request') {
      options.expectCompletedRequest = true;
      continue;
    }
    if (Object.hasOwn(valueFlags, arg)) {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error(`Missing value for ${arg}`);
      }
      const key = valueFlags[arg];
      if (key === 'expectClassifierAttempts') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new Error(`Invalid integer for ${arg}: ${value}`);
        }
        options[key] = parsed;
      } else {
        options[key] = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function runCli(argv) {
  const options = parseArgs(argv);
  assert.ok(typeof options.file === 'string' && options.file.length > 0, '--file is required');
  const records = parseJsonl(fs.readFileSync(options.file, 'utf8'));
  const selection = assertModelRoutingRecords(records, options);
  const label = options.label || 'ROUTING_SELECTION_AUDIT';
  const details = selection.selection_source === 'fallback'
    ? `source=fallback reason=${selection.fallback_reason} tier=${selection.fallback_tier} model=${selection.wire_model}`
    : `source=router model=${selection.wire_model}`;
  console.log(`${label}=passed ${details}`);
  return selection;
}

if (require.main === module) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}

module.exports = {
  parseJsonl,
  assertModelRoutingRecords,
  parseArgs,
  runCli,
};
