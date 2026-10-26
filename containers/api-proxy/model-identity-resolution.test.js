'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const https = require('node:https');
const {
  makeReq, makeRes, flushPromises, createMockUpstreamCycle,
} = require('./test-helpers/server-mock-factories');

jest.mock('./model-information.naming.generated.json', () => ({
  models: [
    {
      identity: {
        key: 'copilot/wire-model', provider: 'copilot', rawId: 'wire-model', lookupId: 'wire-model',
        aliases: [
          { id: 'friendly', match: 'exact', scope: { provider: 'copilot', channel: 'copilot-api' } },
          { id: 'deployment-name', match: 'exact', scope: { provider: 'copilot', channel: 'copilot-api', deployment: 'private' } },
        ],
      },
    },
    {
      identity: {
        key: 'copilot/conflict-one', provider: 'copilot', rawId: 'conflict-one', lookupId: 'conflict-one',
        aliases: [{ id: 'ambiguous', match: 'exact', scope: { provider: 'copilot', channel: 'copilot-api' } }],
      },
    },
    {
      identity: {
        key: 'copilot/conflict-two', provider: 'copilot', rawId: 'conflict-two', lookupId: 'conflict-two',
        aliases: [{ id: 'ambiguous', match: 'exact', scope: { provider: 'copilot', channel: 'copilot-api' } }],
      },
    },
    {
      identity: {
        key: 'openai/wire-model', provider: 'openai', rawId: 'wire-model', lookupId: 'wire-model',
      },
    },
    {
      identity: {
        key: 'copilot/gpt-5-codex', provider: 'copilot', rawId: 'gpt-5-codex', lookupId: 'gpt-5-codex',
        aliases: [{ id: 'old-codex', match: 'exact', scope: { provider: 'copilot', channel: 'copilot-api' } }],
      },
    },
  ],
  rules: [],
}));

const { resolveModelIdentity } = require('./model-identity');
const { resolveModel } = require('./model-resolver');
const { rewriteModelInBody } = require('./model-body-rewriter');
const { resolveModelSelector } = require('./model-selector');
const noFallback = { enabled: false };

it('rewrites scoped identity aliases to discovered wire IDs and preserves parameters', () => {
  const result = rewriteModelInBody(
    Buffer.from('{"model":"Copilot/friendly?effort=high","messages":[]}'),
    'copilot', {}, { copilot: ['wire-model'] }, noFallback,
  );
  expect(JSON.parse(result.body)).toEqual({ model: 'wire-model?effort=high', messages: [] });
  expect(result).toMatchObject({
    identity: { key: 'copilot/wire-model' }, wireId: 'wire-model', matchKind: 'alias',
  });
  expect(resolveModelSelector('friendly?effort=high', 'copilot', ['wire-model'], []))
    .toMatchObject({ resolvedModel: 'wire-model?effort=high', identity: result.identity });
});

it('does not turn naming facts into availability or cross provider/deployment boundaries', () => {
  expect(resolveModel('friendly', {}, { copilot: [] }, 'copilot', [], noFallback)).toBeNull();
  expect(resolveModel('friendly', {}, { openai: ['wire-model'] }, 'openai', [], noFallback)).toBeNull();
  expect(resolveModel('openai/wire-model', {}, { copilot: ['wire-model'] }, 'copilot', [], noFallback)).toBeNull();
  expect(resolveModelIdentity('wire-model', 'copilot').identity.key).toBe('copilot/wire-model');
  expect(resolveModelIdentity('wire-model', 'openai').identity.key).toBe('openai/wire-model');
  expect(resolveModelIdentity('deployment-name', 'copilot').matchKind).toBe('unmatched');
  expect(resolveModelIdentity('deployment-name', 'copilot', { scope: { deployment: 'private' } }))
    .toMatchObject({ wireId: 'wire-model', matchKind: 'alias' });
});

it('checks the resolved target for denied and retired aliases, including automatic fallback', () => {
  const available = { copilot: ['wire-model'] };
  const policy = { disallowedModels: ['copilot/wire-model'] };
  expect(resolveModel('friendly', {}, available, 'copilot', [], noFallback, policy)).toBeNull();
  expect(resolveModel('nested', { nested: ['friendly'] }, available, 'copilot', [], noFallback, policy)).toBeNull();
  expect(resolveModel('unknown', {}, available, 'copilot', [], { enabled: true }, policy)).toBeNull();
  expect(resolveModel('old-codex', {}, { copilot: ['gpt-5-codex'] }, 'copilot')).toBeNull();
  expect(resolveModel('legacy', { legacy: ['copilot/gpt-5-codex'] },
    { copilot: ['gpt-5-codex', 'wire-model'] }, 'copilot')).toBeNull();
  expect(resolveModel('unknown', {}, { copilot: ['gpt-5-codex'] }, 'copilot')).toBeNull();
  expect(resolveModel('outer', {
    inner: ['copilot/gpt-5-codex'], outer: ['inner', 'copilot/no-such-model'],
  }, { copilot: ['gpt-5-codex', 'wire-model'] }, 'copilot')).toBeNull();
  const aliases = {
    inner: ['copilot/gpt-5-codex'], backup: ['copilot/no-such-model'], outer: ['inner', 'backup'],
  };
  expect(resolveModel('outer', aliases, { copilot: ['gpt-5-codex', 'wire-model'] }, 'copilot')).toBeNull();
  expect(resolveModel('outer', { ...aliases, outer: ['inner', 'copilot/wire*'] },
    { copilot: ['gpt-5-codex', 'wire-model'] }, 'copilot').resolvedModel).toBe('wire-model');
});

it('retains exact available ID precedence, recursive routing expressions, and loop detection', () => {
  const available = { copilot: ['wire-model', 'other-model'] };
  const aliases = { 'wire-model': ['copilot/other*'], nested: ['choice'], choice: ['copilot/wire*'] };
  expect(resolveModel('wire-model', aliases, available, 'copilot').resolvedModel).toBe('wire-model');
  expect(resolveModel('nested?effort=low', aliases, available, 'copilot').resolvedModel)
    .toBe('wire-model?effort=low');
  expect(resolveModel('nested', { nested: ['friendly'] }, available, 'copilot', [], noFallback))
    .toMatchObject({ resolvedModel: 'wire-model', matchKind: 'routing-alias' });
  expect(resolveModel('a', { a: ['b'], b: ['a'] }, available, 'copilot', [], noFallback)).toBeNull();
  expect(() => resolveModel('team', { Team: ['copilot/wire*'], TEAM: ['copilot/other*'] },
    available, 'copilot', [], noFallback)).toThrow('Ambiguous routing alias');
  expect(() => resolveModel('ambiguous', {}, available, 'copilot', [], noFallback))
    .toThrow('Ambiguous model identity');
});

it('does not globally fold separators or strip dates from request names', () => {
  for (const model of ['wire_model', 'wire-model-20261015']) {
    expect(resolveModel(model, {}, { copilot: ['wire-model'] }, 'copilot', [], noFallback)).toBeNull();
  }
});

it('retains provider-native slash IDs and their identity after consuming one redundant prefix', () => {
  const nativeId = 'copilot/deployments/team';
  const request = `copilot/${nativeId}?effort=high`;
  const available = ['deployments/team', nativeId];
  expect(resolveModel(request, {}, { copilot: available }, 'copilot', [], noFallback))
    .toMatchObject({
      resolvedModel: `${nativeId}?effort=high`, wireId: nativeId,
      identity: { key: `copilot/${nativeId}`, rawId: nativeId },
    });
  expect(resolveModelSelector(request, 'copilot', available, []))
    .toMatchObject({ resolvedModel: `${nativeId}?effort=high`, identity: { rawId: nativeId } });
});

it('does not implicitly capture specialized variants with the legacy GPT family alias', () => {
  expect(resolveModel('gpt-5.5-cyber', { 'gpt-5': ['openai/gpt-5*'] },
    { openai: ['gpt-5.6'] }, 'openai', [], noFallback)).toBeNull();
  expect(resolveModel('gpt-5.9', {}, { openai: ['gpt-5.5-cyber', 'gpt-5.4'] },
    'openai', [], noFallback).resolvedModel).toBe('gpt-5.4');
});

describe('request pipeline with bundled identity aliases and no routing aliases', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  async function send(model, policy) {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith('AWF_')) delete process.env[name];
    }
    delete process.env.HTTPS_PROXY;
    if (policy) process.env.AWF_DISALLOWED_MODELS = JSON.stringify(policy);
    let proxyRequest;
    let makeModelBodyTransform;
    jest.isolateModules(() => {
      ({ proxyRequest } = require('./proxy-request'));
      ({ makeModelBodyTransform } = require('./model-config'));
    });
    const upstream = createMockUpstreamCycle(https);
    const req = makeReq('/chat/completions');
    const res = makeRes();
    const transform = makeModelBodyTransform(
      'copilot', { copilot: ['wire-model', 'gpt-5-codex'] }, jest.fn(),
      () => new Set(['copilot']), () => [],
    );
    proxyRequest(req, res, 'api.githubcopilot.com', {}, 'copilot', '', transform);
    req.emit('data', Buffer.from(JSON.stringify({ model, messages: [] })));
    req.emit('end');
    await flushPromises();
    return { upstream, req, res };
  }

  it('forwards the resolved wire ID and retains the canonical request identity', async () => {
    const { upstream, req } = await send('Copilot/friendly?effort=high');
    expect(upstream.spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(upstream.upstreamRequest.write.mock.calls[0][0].toString()).model)
      .toBe('wire-model?effort=high');
    expect(req.awfModelIdentity.key).toBe('copilot/wire-model');
  });

  it('rejects a policy-denied alias target before contacting upstream', async () => {
    const { upstream, res } = await send('friendly', ['copilot/wire-model']);
    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(403, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error.type).toBe('model_policy_violation');
  });

  it('rejects a retired alias target instead of reviving it through discovery', async () => {
    const { upstream, res } = await send('old-codex');
    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error.type).toBe('retired_model');
  });

  it('returns an actionable error for an ambiguous applicable identity alias', async () => {
    const { upstream, res } = await send('ambiguous');
    expect(upstream.spy).not.toHaveBeenCalled();
    expect(res.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(JSON.parse(res.end.mock.calls[0][0]).error.message).toContain('Ambiguous model identity');
  });
});

it('loads actual Docker-staged resolution assets without repository-relative source imports', () => {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-naming-package-'));
  try {
    const dockerfile = fs.readFileSync(path.join(__dirname, 'Dockerfile'), 'utf8');
    const copy = dockerfile.match(/^COPY server\.js[\s\S]*? \.\/$/m)[0];
    const files = copy.replace(/^COPY /, '').replace(/\\\n/g, ' ').trim().split(/\s+/).slice(0, -1);
    for (const file of files) fs.copyFileSync(path.join(__dirname, file), path.join(stage, file));
    for (const directory of ['guards', 'providers', 'transforms', 'catalogue-contract']) {
      fs.cpSync(path.join(__dirname, directory), path.join(stage, directory), { recursive: true });
    }
    fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(stage, 'node_modules'), 'dir');
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const { resolveModel } = require('./model-resolver');
      const { rewriteModelInBody } = require('./model-body-rewriter');
      const result = resolveModel('copilot/gpt-5.3-codex?effort=high', {},
        {copilot:['gpt-5.3-codex']}, 'copilot', [], {enabled:false});
      assert.equal(result.identity.key, 'copilot/gpt-5.3-codex');
      assert.equal(result.resolvedModel, 'gpt-5.3-codex?effort=high');
      assert.equal(JSON.parse(rewriteModelInBody(Buffer.from('{"model":"copilot/gpt-5.3-codex"}'),
        'copilot', {}, {copilot:['gpt-5.3-codex']}, {enabled:false}).body).model, 'gpt-5.3-codex');
    `], { cwd: stage, encoding: 'utf8' });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
});
