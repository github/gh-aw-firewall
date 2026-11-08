import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { identity } from '../shared/model-information/identity';
import {
  resolveReasoning, assessReasoningEffort, ReasoningFact,
} from '../shared/model-information/reasoning';

const scope = { provider: 'copilot', channel: 'copilot-api' };
const exact = identity('copilot', 'exact');
const fact = (extra: Partial<ReasoningFact> = {}): ReasoningFact => ({
  identity: exact, scope, active: true, authority: 'provider',
  support: 'supported', rawEfforts: ['none', 'low', 'max', 'future-effort'],
  provenance: { authority: 'provider', source: 'fixture', at: '2026-11-01T00:00:00Z' },
  ...extra,
});
const resolve = (...facts: ReasoningFact[]) => resolveReasoning({ identity: exact, scope, facts });

describe('exact-model reasoning decisions', () => {
  it('distinguishes absence, explicit unknown, unsupported and supported evidence', () => {
    expect(resolve().support).toBe('absent');
    expect(resolve(fact({ support: 'unknown', rawEfforts: undefined })).support).toBe('unknown');
    expect(resolve(fact({ support: 'unsupported', rawEfforts: [] })).support).toBe('unsupported');
    const decision = resolve(fact());
    expect(decision.support).toBe('supported');
    expect(decision.mode).toBe('unknown');
    expect(decision.supportedEfforts).toEqual(['none', 'low', 'max', 'future-effort']);
    expect(decision.selectableEfforts).toEqual(['none', 'low', 'max']);
    expect(decision.observations[0]).toMatchObject({
      rawEfforts: ['none', 'low', 'max', 'future-effort'],
      provenance: { source: 'fixture' }, selected: true,
    });
    expect(decision.reasons).toContainEqual({ code: 'reasoning_future_effort_not_selectable' });
  });

  it.each(['none', 'max', 'future-effort'])('accepts exact supported direct value %s without substitution', effort => {
    const decision = resolve(fact());
    expect(assessReasoningEffort(decision, effort).admitted).toBe(true);
    expect(assessReasoningEffort(decision, effort, { automatic: true }).admitted)
      .toBe(effort !== 'future-effort');
    expect(assessReasoningEffort(decision, 'unsupported').admitted).toBe(false);
  });

  it.each(['absent', 'unknown'] as const)('names direct unknown pass-through versus automatic known-support policy: %s', support => {
    const decision = support === 'absent' ? resolve() : resolve(fact({ support, rawEfforts: undefined }));
    for (const effort of [undefined, 'none', 'max', 'future-effort']) {
      expect(assessReasoningEffort(decision, effort)).toEqual({
        admitted: true, reasons: [{ code: 'reasoning_direct_unknown_passthrough' }],
      });
      expect(assessReasoningEffort(decision, effort, { automatic: true }).admitted).toBe(false);
    }
  });

  it('uses evidenced required, optional, forbidden and default facts without inventing them', () => {
    const required = resolve(fact({ mode: 'required', default: 'low' }));
    expect(required.default).toBe('low');
    expect(assessReasoningEffort(required, undefined).admitted).toBe(false);
    expect(assessReasoningEffort(required, 'low').admitted).toBe(true);
    const optional = resolve(fact({ mode: 'optional' }));
    expect(assessReasoningEffort(optional, undefined).admitted).toBe(true);
    expect(optional).not.toHaveProperty('default');
    const forbidden = resolve(fact({ mode: 'forbidden', support: 'unsupported', rawEfforts: [] }));
    expect(assessReasoningEffort(forbidden, undefined, { automatic: true }).admitted).toBe(true);
    expect(assessReasoningEffort(forbidden, 'none').admitted).toBe(false);
    const invalid = resolve(fact({ default: 'high' }));
    expect(invalid).not.toHaveProperty('default');
    expect(invalid.reasons).toContainEqual({ code: 'reasoning_invalid_default' });
  });

  it('ignores other providers, channels, deployments, staged targets and unreviewed sources', () => {
    const ignored = [
      fact({ identity: identity('openai', 'exact') }),
      fact({ scope: { ...scope, channel: 'native-api' } }),
      fact({ scope: { ...scope, deployment: 'other' } }),
      fact({ active: false }),
      fact({ authority: 'models.dev' as ReasoningFact['authority'] }),
      fact({ identity: identity('copilot', 'exact-mini') }),
    ];
    const decision = resolve(...ignored);
    expect(decision.support).toBe('absent');
    expect(decision.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining([
      'reasoning_identity_mismatch', 'reasoning_scope_mismatch',
      'reasoning_inactive_fact', 'reasoning_unreviewed_authority',
    ]));
    expect(resolve(fact({ identity: { ...exact, family: 'accounting-only' } })))
      .toEqual(resolve(fact()));
  });

  it('prefers provider facts, including unknowns, without lower-authority fallback', () => {
    const maintained = fact({ authority: 'maintained', rawEfforts: ['high'] });
    const decision = resolve(maintained, fact({ support: 'unknown', rawEfforts: undefined }));
    expect(decision.support).toBe('unknown');
    expect(decision.observations.map(observation => observation.selected)).toEqual([false, true]);
  });

  it('makes same-authority contradictions explicitly unknown regardless of order', () => {
    const first = fact();
    const second = fact({ rawEfforts: ['high'] });
    for (const facts of [[first, second], [second, first]]) {
      const decision = resolve(...facts);
      expect(decision).toMatchObject({ support: 'unknown', mode: 'unknown', supportedEfforts: [] });
      expect(decision.reasons).toContainEqual({ code: 'reasoning_conflicting_facts' });
    }
  });

  it.each([
    { rawEfforts: 'low' },
    { support: 'supported', rawEfforts: [] },
    { support: 'unsupported', rawEfforts: ['low'] },
    { mode: 'required', support: 'unsupported', rawEfforts: [] },
    { mode: 'forbidden' },
    { mode: 'marketing-default' },
  ])('reports malformed or contradictory facts as unknown: %j', malformed => {
    const decision = resolve(fact(malformed as Partial<ReasoningFact>));
    expect(decision.support).toBe('unknown');
    expect(decision.reasons).toContainEqual({ code: 'reasoning_malformed_fact' });
  });

  it('preserves the router mixed-array policy but records ignored malformed elements', () => {
    const decision = resolve(fact({ rawEfforts: ['low', null, 'future'] as unknown as string[] }));
    expect(decision.selectableEfforts).toEqual(['low']);
    expect(decision.reasons).toContainEqual({ code: 'reasoning_malformed_effort_ignored' });
  });

  it('does not turn unverified conditions into support', () => {
    const decision = resolve(fact({ support: 'conditional' }));
    expect(decision.support).toBe('unknown');
    expect(decision.reasons).toContainEqual({ code: 'reasoning_condition_unverified' });
  });

  it('copies and deeply freezes facts, including future values and sanitized provenance', () => {
    const source = fact({ provenance: { source: 'fixture\n', secret: 'must-not-leak', nested: {} } });
    const pinned = resolve(source);
    (source.rawEfforts as string[]).push('high');
    source.provenance!.source = 'replacement';
    expect(pinned.supportedEfforts).not.toContain('high');
    expect(pinned.observations[0].provenance).toEqual({ source: 'fixture' });
    expect(Object.isFrozen(pinned.observations[0].rawEfforts)).toBe(true);
    expect(Object.isFrozen(pinned.reasons[0])).toBe(true);
    expect(resolve(source).supportedEfforts).toContain('high');
  });
});

describe('shipped reasoning contract', () => {
  const root = path.resolve(__dirname, '..');
  it('projects identical modules and declarations without regenerating catalogue data', () => {
    execFileSync(process.execPath, [
      path.join(root, 'scripts/model-information/compile.cjs'), '--contracts-only', '--check',
    ]);
    for (const directory of ['src/model-information-contract', 'containers/api-proxy/catalogue-contract']) {
      for (const file of ['reasoning.js', 'reasoning.d.ts']) {
        expect(fs.readFileSync(path.join(root, directory, file)))
          .toEqual(fs.readFileSync(path.join(root, 'shared/model-information', file)));
      }
    }
  });

  it('executes provider-free from off-tree built and proxy package layouts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'awf-reasoning-package-'));
    try {
      for (const [name, source] of [
        ['built', 'dist/model-information-contract'],
        ['proxy', 'containers/api-proxy/catalogue-contract'],
      ]) {
        fs.mkdirSync(path.join(directory, name));
        for (const file of ['reasoning.js', 'reasoning.d.ts', 'identity.d.ts', 'resolution.d.ts']) {
          fs.copyFileSync(path.join(root, source, file), path.join(directory, name, file));
        }
        expect(fs.readFileSync(path.join(directory, name, 'reasoning.d.ts')))
          .toEqual(fs.readFileSync(path.join(root, 'shared/model-information/reasoning.d.ts')));
      }
      execFileSync(process.execPath, ['-e', `
        const assert = require('node:assert/strict');
        for (const name of ['built', 'proxy']) {
          const {resolveReasoning, assessReasoningEffort} = require('./' + name + '/reasoning');
          const identity = {key:'copilot/exact', provider:'copilot', rawId:'exact'};
          const scope = {provider:'copilot', channel:'copilot-api'};
          const decision = resolveReasoning({identity, scope, facts:[{
            identity, scope, active:true, authority:'provider', support:'supported', rawEfforts:['none','max','future']
          }]});
          assert.deepEqual(decision.selectableEfforts, ['none','max']);
          assert.equal(assessReasoningEffort(decision, 'future', {automatic:true}).admitted, false);
          assert.equal(Object.isFrozen(decision), true);
        }
      `], { cwd: directory, env: { ...process.env, NODE_PATH: '' } });
      const fixture = path.join(directory, 'consumer.ts');
      fs.writeFileSync(fixture, `
        import { resolveReasoning, ReasoningDecision } from './built/reasoning';
        import { assessReasoningEffort } from './proxy/reasoning';
        const decision: ReasoningDecision = resolveReasoning({
          identity: {key:'copilot/exact', provider:'copilot', rawId:'exact', lookupId:'exact'},
          scope: {provider:'copilot', channel:'copilot-api'}, facts:[]
        });
        assessReasoningEffort(decision, 'future');
        // @ts-expect-error A non-string effort is not part of the internal contract.
        assessReasoningEffort(decision, {});
        // @ts-expect-error A decision is immutable.
        decision.supportedEfforts.push('max');
      `);
      execFileSync(process.execPath, [
        path.join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--noEmit',
        '--skipLibCheck', '--target', 'ES2020', '--moduleResolution', 'node', fixture,
      ], { cwd: directory });
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
