'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { writeRoutingRecord } = require('./routing-persistence');
const { resetCopilotInteractionIdForTests } = require('./request-headers');
const { createRoutingObserver } = require('./routing-runtime');

describe('routing persistence', () => {
  let directory;
  let saved;
  const keys = [
    'AWF_TOKEN_LOG_DIR', 'AWF_VERSION', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT',
    'GITHUB_REPOSITORY', 'GITHUB_WORKFLOW_REF',
  ];

  beforeEach(() => {
    saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-routing-logs-'));
    process.env.AWF_TOKEN_LOG_DIR = directory;
    process.env.AWF_VERSION = '1.2.3';
    resetCopilotInteractionIdForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    resetCopilotInteractionIdForTests();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function readRecords() {
    return fs.readFileSync(path.join(directory, 'model-routing.jsonl'), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
  }

  test('appends classification, successful and degraded selections, failures, and request outcomes', () => {
    const consoleLog = jest.fn();
    const observer = createRoutingObserver(consoleLog);
    const records = [
      { stage: 'classification', attempt: 1, classifier_model: 'provider/model', classifier_effort: 'low' },
      { stage: 'selection', selected_model: 'provider/model', selected_effort: 'low', degraded_classification: false },
      { stage: 'selection', selected_model: 'provider/model', degraded_classification: true,
        degraded_reason: 'invalid_classifier_output', labels: null, mode: null },
      { stage: 'failure', code: 'no_route', detail: 'The router found no eligible model choice' },
      { stage: 'request', request_id: 'request-1', outcome: 'completed', status: 200, routed: 'as_selected' },
      { stage: 'request', request_id: 'request-2', outcome: 'rejected', status: 403, routed: 'deviated' },
    ];
    for (const record of records) observer.record(record);
    const written = readRecords();
    expect(written).toHaveLength(records.length);
    records.forEach((record, index) => expect(written[index]).toMatchObject({
      ...record, _schema: 'model-routing/v1.2.3', event: 'model_routing',
      timestamp: expect.any(String),
    }));
    expect(consoleLog).toHaveBeenCalledTimes(records.length);
  });

  test('selection carries the stable interaction and optional Actions identity', () => {
    process.env.GITHUB_RUN_ID = '12345';
    process.env.GITHUB_RUN_ATTEMPT = '2';
    process.env.GITHUB_REPOSITORY = 'owner/repo';
    process.env.GITHUB_WORKFLOW_REF = 'owner/repo/.github/workflows/test.yml@refs/heads/main';
    writeRoutingRecord({ stage: 'selection' });
    expect(readRecords()[0]).toMatchObject({
      interaction_id: '12345-2',
      github_repository: 'owner/repo',
      github_workflow_ref: process.env.GITHUB_WORKFLOW_REF,
    });
  });

  test('non-Actions selection omits repository and workflow but retains a stable interaction ID', () => {
    writeRoutingRecord({ stage: 'selection' });
    writeRoutingRecord({ stage: 'selection' });
    const records = readRecords();
    expect(records[0].interaction_id).toBe(records[1].interaction_id);
    expect(records[0].interaction_id).toEqual(expect.any(String));
    expect(records[0]).not.toHaveProperty('github_repository');
    expect(records[0]).not.toHaveProperty('github_workflow_ref');
  });

  test('does not persist conversation, classifier prompts, raw output, or credentials', () => {
    writeRoutingRecord({
      stage: 'selection',
      conversation_sha256: 'a'.repeat(64),
      conversation: 'private conversation',
      prompt: 'private classifier prompt',
      system_prompt: 'private system prompt',
      raw_output: 'private classifier output',
      authorization: 'private credential',
    });
    const record = readRecords()[0];
    expect(record.conversation_sha256).toBe('a'.repeat(64));
    expect(JSON.stringify(record)).not.toContain('private');
  });

  test('uses the development schema fallback', () => {
    delete process.env.AWF_VERSION;
    writeRoutingRecord({ stage: 'failure', code: 'no_route' });
    expect(readRecords()[0]._schema).toBe('model-routing/v0.0.0-dev');
  });

  test('write and console failures never escape the observer', () => {
    const observer = createRoutingObserver(() => { throw new Error('console unavailable'); });
    observer.record({ stage: 'selection' });
    expect(readRecords()).toHaveLength(1);
    fs.rmSync(directory, { recursive: true });
    fs.writeFileSync(directory, 'not a directory');
    expect(() => observer.record({ stage: 'failure', code: 'no_route' })).not.toThrow();
  });

  test('refuses to follow log symlinks or append to hardlinked files', () => {
    const target = path.join(directory, 'target');
    const log = path.join(directory, 'model-routing.jsonl');
    fs.writeFileSync(target, 'unchanged');
    fs.symlinkSync(target, log);
    writeRoutingRecord({ stage: 'selection' });
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
    fs.unlinkSync(log);
    fs.linkSync(target, log);
    writeRoutingRecord({ stage: 'selection' });
    expect(fs.readFileSync(target, 'utf8')).toBe('unchanged');
  });
});
