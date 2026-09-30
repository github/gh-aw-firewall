import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-require-imports */
const root = path.join(__dirname, '..', '..', 'containers');
const {
  AGENT_TOOL_NAME,
  TOOL_NAME,
  dispatchJsonRpc,
} = require(path.join(root, 'enclave', 'mcp-server', 'mcp-protocol.js'));
const { createSingleToolAdmission } = require(path.join(root, 'enclave', 'mcp-server', 'server.js'));
const {
  TOOL_CALL_CAP_MESSAGE,
  createToolCallBudget,
} = require(path.join(root, 'enclave', 'mcp-server', 'tool-call-budget.js'));
const { CANONICAL_ERROR_RESPONSE_JSON } = require(path.join(root, 'bounded-execution', 'finite-disclosure.js'));
/* eslint-enable @typescript-eslint/no-require-imports */
import { createRpcTestHarness } from './mcp-server.test-utils';

const { rpc, fakeBroker } = createRpcTestHarness(CANONICAL_ERROR_RESPONSE_JSON);
const RUN_ID = '0123456789abcdef';
const scriptArguments = {
  privateRepo: 'octo/private',
  schema: { type: 'boolean' },
  script: 'print(1)',
};
const agentArguments = {
  privateRepo: 'octo/private',
  schema: { type: 'boolean' },
  prompt: 'check',
};

function callTool(name: string, args: unknown, deps: unknown, id = 1) {
  return dispatchJsonRpc(rpc('tools/call', { name, arguments: args }, id), deps);
}

describe('enclave tool-call cap', () => {
  let stateDir: string;
  let statePath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-tool-call-budget-'));
    statePath = path.join(stateDir, 'control', 'tool-call-budget.json');
  });

  afterEach(() => {
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it('is a no-op when no finite limit is configured', async () => {
    expect(createToolCallBudget({ runId: RUN_ID, statePath })).toBeUndefined();
    const deps = {
      handlers: { [TOOL_NAME]: fakeBroker('{"status":"ok","result":true}') },
      maxScriptBytes: 65536,
      toolCallBudget: createToolCallBudget({ runId: RUN_ID, statePath }),
    };
    for (let id = 1; id <= 5; id += 1) {
      const response = await callTool(TOOL_NAME, scriptArguments, deps, id);
      expect(response.result.structuredContent).toEqual({ status: 'ok', result: true });
    }
    const listed = await dispatchJsonRpc(rpc('tools/list', {}), deps);
    expect(listed.result.tools[0].description).not.toMatch(/at most/);
    const initialized = await dispatchJsonRpc(rpc('initialize', {}), deps);
    expect(initialized.result).not.toHaveProperty('instructions');
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    expect(() => createToolCallBudget({ maxToolCalls: 0 })).toThrow('positive integer');
    expect(() => createToolCallBudget({ maxToolCalls: 1.5 })).toThrow('positive integer');
  });

  it('advertises a finite limit to the calling model', async () => {
    const deps = {
      handlers: {
        [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON),
        [AGENT_TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON),
      },
      toolCallBudget: createToolCallBudget({ maxToolCalls: 3, runId: RUN_ID, warn: () => {} }),
    };
    const listed = await dispatchJsonRpc(rpc('tools/list', {}), deps);
    expect(listed.result.tools).toHaveLength(2);
    for (const tool of listed.result.tools) {
      expect(tool.description).toContain('You are allowed to make at most 3 enclave tool calls');
      expect(tool.description).toContain('the system will deny any further enclave tool calls');
    }
    const initialized = await dispatchJsonRpc(rpc('initialize', {}), deps);
    expect(initialized.result.instructions).toContain('at most 3 enclave tool calls');
  });

  it('counts every attempted call across tools and denies in-band once exhausted', async () => {
    const warnings: string[] = [];
    const scriptRequests: unknown[] = [];
    const agentRequests: unknown[] = [];
    const deps = {
      handlers: {
        [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON, scriptRequests),
        [AGENT_TOOL_NAME]: fakeBroker('{"status":"ok","result":true}', agentRequests),
      },
      maxScriptBytes: 4,
      maxPromptBytes: 65536,
      toolCallBudget: createToolCallBudget({
        maxToolCalls: 3,
        runId: RUN_ID,
        statePath,
        warn: (message: string) => warnings.push(message),
      }),
    };

    // A failed call, an oversized call, and a successful call all count.
    expect((await callTool(TOOL_NAME, { ...scriptArguments, runtime: 'runc' }, deps, 1))
      .result.structuredContent).toEqual({ status: 'error' });
    expect((await callTool(TOOL_NAME, scriptArguments, deps, 2))
      .result.structuredContent).toEqual({ status: 'error' });
    expect((await callTool(AGENT_TOOL_NAME, agentArguments, deps, 3))
      .result.structuredContent).toEqual({ status: 'ok', result: true });
    expect(deps.toolCallBudget.used()).toBe(3);

    const denied = await callTool(AGENT_TOOL_NAME, agentArguments, deps, 4);
    await callTool(TOOL_NAME, scriptArguments, deps, 5);
    expect(denied).toEqual({
      jsonrpc: '2.0',
      id: 4,
      result: {
        content: [{ type: 'text', text: TOOL_CALL_CAP_MESSAGE }],
        structuredContent: { status: 'error' },
        isError: true,
      },
    });
    expect(TOOL_CALL_CAP_MESSAGE).toBe(
      'Max tool call count reached, no more tool calls are allowed. '
      + 'Make a decision based on what you already have in context.',
    );
    // Denied calls never reach an executor, and the denial is warned once.
    expect(agentRequests).toHaveLength(1);
    expect(scriptRequests).toHaveLength(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Max tool call count reached.');
    expect(JSON.parse(warnings[0].slice(warnings[0].indexOf('{')))).toEqual({
      toolName: AGENT_TOOL_NAME,
      agentName: 'agent',
      sessionID: RUN_ID,
      maxToolCalls: 3,
    });
  });

  it('counts calls rejected by the single-call admission lane', async () => {
    let finishFirst: (() => void) | undefined;
    const handler = {
      handle: (_request: unknown, respond: (value: string) => void) => new Promise<void>((resolve) => {
        finishFirst = () => {
          respond('{"status":"ok","result":true}');
          resolve();
        };
      }),
    };
    const deps = {
      handlers: { [TOOL_NAME]: handler },
      maxScriptBytes: 65536,
      tryAcquireToolCall: createSingleToolAdmission(),
      toolCallBudget: createToolCallBudget({ maxToolCalls: 2, runId: RUN_ID, warn: () => {} }),
    };
    const first = callTool(TOOL_NAME, scriptArguments, deps, 1);
    await Promise.resolve();
    const busy = await callTool(TOOL_NAME, scriptArguments, deps, 2);
    expect(busy.result.structuredContent).toEqual({ status: 'error' });
    finishFirst!();
    await first;
    const denied = await callTool(TOOL_NAME, scriptArguments, deps, 3);
    expect(denied.result.content[0].text).toBe(TOOL_CALL_CAP_MESSAGE);
  });

  it('does not count malformed protocol requests that never name a published tool', async () => {
    const deps = {
      handlers: { [TOOL_NAME]: fakeBroker(CANONICAL_ERROR_RESPONSE_JSON) },
      toolCallBudget: createToolCallBudget({ maxToolCalls: 1, runId: RUN_ID, warn: () => {} }),
    };
    await expect(callTool('other', {}, deps)).resolves.toMatchObject({ error: { code: -32602 } });
    expect(deps.toolCallBudget.used()).toBe(0);
  });

  it('persists the count for the same run and resets it for a different run', () => {
    const first = createToolCallBudget({ maxToolCalls: 2, runId: RUN_ID, statePath, warn: () => {} });
    expect(first.tryConsume(TOOL_NAME, 'script')).toBe(true);
    expect(first.tryConsume(TOOL_NAME, 'script')).toBe(true);
    expect((fs.statSync(statePath).mode & 0o777).toString(8)).toBe('600');

    const resumed = createToolCallBudget({ maxToolCalls: 2, runId: RUN_ID, statePath, warn: () => {} });
    expect(resumed.used()).toBe(2);
    expect(resumed.tryConsume(TOOL_NAME, 'script')).toBe(false);

    const otherRun = createToolCallBudget({
      maxToolCalls: 2,
      runId: 'fedcba9876543210',
      statePath,
      warn: () => {},
    });
    expect(otherRun.used()).toBe(0);
  });

  it('treats a corrupt state file as a fresh count and keeps enforcing when persistence fails', () => {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, 'not json');
    expect(createToolCallBudget({ maxToolCalls: 1, runId: RUN_ID, statePath }).used()).toBe(0);

    const warnings: string[] = [];
    const failingFiles = {
      ...fs,
      readFileSync: () => { throw new Error('missing'); },
      writeFileSync: () => { throw new Error('read-only'); },
    };
    const budget = createToolCallBudget({
      maxToolCalls: 1,
      runId: RUN_ID,
      statePath,
      files: failingFiles,
      warn: (message: string) => warnings.push(message),
    });
    expect(budget.tryConsume(TOOL_NAME, 'script')).toBe(true);
    expect(budget.tryConsume(TOOL_NAME, 'script')).toBe(false);
    expect(warnings[0]).toContain('Unable to persist enclave tool call count: read-only');
  });

  it('removes a partially written state file when the atomic rename fails', () => {
    const failingFiles = {
      ...fs,
      renameSync: () => { throw new Error('rename failed'); },
    };
    const budget = createToolCallBudget({
      maxToolCalls: 1,
      runId: RUN_ID,
      statePath,
      files: failingFiles,
      warn: () => {},
    });
    expect(budget.tryConsume(TOOL_NAME, 'script')).toBe(true);
    expect(fs.readdirSync(path.dirname(statePath))).toEqual([]);
  });
});
