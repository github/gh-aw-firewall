import { identity } from '../shared/model-information/identity';
import fixtures from '../shared/model-information/fixtures.v1.json';
import {
  createEligibilityStore, evaluateEligibility, EligibilityInput, HarnessRequirement,
} from '../shared/model-information/eligibility';

const scope = { provider: 'copilot', channel: 'copilot-api' };
const model = identity('copilot', 'exact-model');
const requirement: HarnessRequirement = {
  scope, name: 'copilot', scheme: 'semver', minimum: '1.2.3',
  reason: 'Reviewed harness compatibility',
  provenance: { authority: 'maintained', source: 'fixture' },
};
const input = (extra: Partial<EligibilityInput> = {}): EligibilityInput => ({
  identity: model, scope, discovery: { status: 'available', authoritative: true },
  executionEnvironment: 'container:run-1',
  harnesses: [requirement],
  observations: [{
    scope, name: 'copilot', version: '1.2.3', environment: 'container:run-1',
    verified: true, actual: true,
  }], ...extra,
});
const evaluateVersion = (minimum: string, detected: string, scheme = 'semver', excludedRanges: string[] = []) =>
  evaluateEligibility(input({
    harnesses: [{ ...requirement, minimum, scheme: scheme as HarnessRequirement['scheme'], excludedRanges }],
    observations: [{ ...input().observations![0], version: detected }],
  }));

describe('shared scoped model eligibility', () => {
  it('does not impose a Copilot CLI constraint on a different selected native-API harness', () => {
    const nativeModel = fixtures.model;
    const harnesses = nativeModel.harnesses as HarnessRequirement[];
    expect(harnesses[0]).toMatchObject({
      scope: { provider: 'openai', channel: 'native-api' }, name: 'copilot-cli',
    });
    const request = {
      identity: nativeModel.identity, scope: harnesses[0].scope, harnesses,
      discovery: { status: 'available' as const, authoritative: true },
      executionEnvironment: 'container:native', observations: [],
    };
    for (const selectedHarness of ['aider', 'codex']) {
      expect(evaluateEligibility({ ...request, selectedHarness })).toMatchObject({
        status: 'eligible', admitted: true, harness: 'unconstrained', selectedHarness,
      });
    }
    expect(evaluateEligibility(request)).toMatchObject({
      status: 'unknown', admitted: false, harness: 'unverified',
    });
    expect(evaluateEligibility({ ...request, selectedHarness: 'copilot-cli' })).toMatchObject({
      status: 'unknown', admitted: false, harness: 'unverified', selectedHarness: 'copilot-cli',
    });
  });

  it('checks evidence and all constraints for the selected harness without inferring another selection', () => {
    const request = input({
      selectedHarness: 'copilot',
      harnesses: [requirement, { ...requirement, name: 'other', minimum: '9.0.0' }],
    });
    expect(evaluateEligibility(request)).toMatchObject({
      status: 'eligible', admitted: true, harness: 'compatible', selectedHarness: 'copilot',
    });
    expect(evaluateEligibility({ ...request, observations: [] })).toMatchObject({
      status: 'unknown', admitted: false, harness: 'unverified',
    });
    expect(evaluateEligibility({
      ...request, observations: [{ ...request.observations![0], version: '1.0.0' }],
    })).toMatchObject({ status: 'incompatible', admitted: false, harness: 'incompatible' });
    expect(evaluateEligibility({
      ...request, observations: [{ ...request.observations![0], name: 'other' }],
    })).toMatchObject({ status: 'unknown', admitted: false, harness: 'unverified' });
    expect(evaluateEligibility({
      ...request, harnesses: [requirement, { ...requirement, minimum: '9.0.0' }],
    })).toMatchObject({ status: 'incompatible', admitted: false, harness: 'incompatible' });
  });

  it.each([null, false, 0, '', ' \t ', {}, []])(
    'does not let malformed selectedHarness %j remove scoped requirements', selectedHarness => {
      const request = input({ selectedHarness: selectedHarness as unknown as string });
      expect(evaluateEligibility(request)).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
        reasons: [expect.objectContaining({ code: 'harness_selection_invalid', name: 'copilot' })],
      });
      expect(evaluateEligibility({ ...request, harnesses: [] })).toMatchObject({
        status: 'eligible', admitted: true, harness: 'unconstrained',
      });
    },
  );

  it('matches selected harness names exactly without normalizing or inferring from observations', () => {
    expect(evaluateEligibility(input({ selectedHarness: 'Copilot' }))).toMatchObject({
      status: 'eligible', admitted: true, harness: 'unconstrained', selectedHarness: 'Copilot',
    });
    expect(evaluateEligibility(input({
      harnesses: [requirement, { ...requirement, name: 'other' }],
    }))).toMatchObject({ status: 'unknown', admitted: false, harness: 'unverified' });
  });

  it.each([undefined, null, false, 0, '', ' \t ', {}, []])(
    'does not skip a malformed scoped requirement name %j for a known selection', name => {
      expect(evaluateEligibility(input({
        selectedHarness: 'copilot',
        harnesses: [{ ...requirement, name: name as unknown as string }],
      }))).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
        reasons: [expect.objectContaining({ code: 'harness_constraint_invalid' })],
      });
    },
  );

  it('does not validate an irrelevant floor when a valid different harness name establishes non-applicability', () => {
    expect(evaluateEligibility(input({
      selectedHarness: 'copilot',
      harnesses: [requirement, { ...requirement, name: 'other', minimum: 'not-a-version' }],
    }))).toMatchObject({
      status: 'eligible', admitted: true, harness: 'compatible', selectedHarness: 'copilot',
    });
  });

  it('pins selected harness defaults and applies explicit selection without mutating earlier snapshots', () => {
    const state = {
      models: [{ identity: model, harnesses: [requirement] }],
      selectedHarness: 'aider', executionEnvironment: 'container:run-1',
    };
    const store = createEligibilityStore(state);
    const first = store.pin();
    const request = { identity: model, scope, discovery: input().discovery };
    expect(first.evaluate(request)).toMatchObject({
      admitted: true, harness: 'unconstrained', selectedHarness: 'aider',
    });
    state.selectedHarness = 'copilot';
    store.replace(state);
    const second = store.pin();
    expect(first.evaluate(request)).toMatchObject({
      admitted: true, harness: 'unconstrained', selectedHarness: 'aider',
    });
    expect(second.evaluate(request)).toMatchObject({
      admitted: false, harness: 'unverified', selectedHarness: 'copilot',
    });
    expect(second.evaluate({ ...request, observations: input().observations })).toMatchObject({
      admitted: true, harness: 'compatible', selectedHarness: 'copilot',
    });
    expect(second.evaluate({ ...request, selectedHarness: 'aider' })).toMatchObject({
      admitted: true, harness: 'unconstrained', selectedHarness: 'aider',
    });
    expect(first.evaluate({ ...request, selectedHarness: '' })).toMatchObject({
      admitted: false, harness: 'unverified',
    });
    expect(second.revision).toBe(first.revision + 1);
  });

  it('distinguishes discovery unknown from authoritative unavailability without rejecting legacy models', () => {
    expect(evaluateEligibility(input({ harnesses: [], discovery: undefined }))).toMatchObject({
      status: 'unknown', admitted: true, harness: 'unconstrained',
    });
    expect(evaluateEligibility(input({ harnesses: [] }))).toMatchObject({
      status: 'eligible', admitted: true, harness: 'unconstrained',
    });
    for (const authoritative of [false, undefined]) {
      expect(evaluateEligibility(input({
        discovery: { status: 'unavailable', authoritative },
      }))).toMatchObject({ status: 'unknown', admitted: true });
    }
    expect(evaluateEligibility(input({
      discovery: { status: 'unavailable', authoritative: true },
    }))).toMatchObject({ status: 'incompatible', admitted: false });
  });

  it.each([
    ['1.2.3', '1.2.3', true], ['1.2.3', '1.2.2', false],
    ['1.2.3', '1.10.0', true], ['1.2.3', '1.2.3-rc.9', false],
    ['1.2.3-rc.9', '1.2.3-rc.10', true],
    ['1.2.3-rc.10', '1.2.3-rc.9', false],
    ['1.2.3-1', '1.2.3-alpha', true],
    ['1.2.3-alpha', '1.2.3-alpha.1', true],
    ['1.2.3-alpha.1', '1.2.3-alpha', false],
    ['1.2.3+build.9', '1.2.3+build.1', true],
    ['99999999999999999999.0.0', '100000000000000000000.0.0', true],
  ])('compares strict semver %s with %s (%s)', (minimum, detected, admitted) => {
    expect(evaluateVersion(minimum, detected).admitted).toBe(admitted);
  });

  it.each([
    ['1.2', '1.2.0', true], ['1.2.9', '1.2', false],
    ['1.2', '1.10', true], ['10', '2', false],
  ])('compares numeric components %s with %s', (minimum, detected, admitted) => {
    expect(evaluateVersion(minimum, detected, 'numeric-components').admitted).toBe(admitted);
  });

  it.each([
    ['1.2.3', false], ['1.4.0', true], ['2.0.0', false], ['3.0.0', true],
  ])('supports explicit excluded conjunctions and disjunctions for %s', (detected, admitted) => {
    expect(evaluateVersion('1.0.0', detected, 'semver',
      ['>=1.2.0 <1.4.0 || =2.0.0']).admitted).toBe(admitted);
  });

  it.each([
    ['1.2', true], ['1.2.0', true], ['1.2.1', false],
    ['1.4', false], ['1.4.0', false], ['1.4.1', true],
    ['2', false], ['2.0', false], ['2.0.1', true],
  ])('honors exact numeric-components exclusion boundaries for %s', (detected, admitted) => {
    expect(evaluateVersion('1.0', detected, 'numeric-components',
      ['>1.2 <=1.4 || =2.0']).admitted).toBe(admitted);
  });

  it.each([
    ['1.2.3', true], ['1.2.4', false], ['1.3.0', false], ['1.3.1', true],
  ])('honors > and <= semver exclusion boundaries for %s', (detected, admitted) => {
    expect(evaluateVersion('1.0.0', detected, 'semver',
      ['>1.2.3 <=1.3.0']).admitted).toBe(admitted);
  });

  it.each(['1.02', '1.x', '1.2-rc', '01', '1..2'])(
    'fails closed for malformed numeric-components %s', value => {
      expect(evaluateVersion(value, '2.0', 'numeric-components')).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
      expect(evaluateVersion('1.0', value, 'numeric-components')).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
      expect(evaluateVersion('1.0', '2.0', 'numeric-components', [`>=${value}`]))
        .toMatchObject({ status: 'unknown', admitted: false, harness: 'unverified' });
    },
  );

  it('fails closed when actual verified observation evidence lacks a version', () => {
    const observation = { ...input().observations![0] };
    Reflect.deleteProperty(observation, 'version');
    expect(evaluateEligibility(input({ observations: [observation] }))).toMatchObject({
      status: 'unknown', admitted: false, harness: 'unverified',
      reasons: [expect.objectContaining({ code: 'harness_observation_invalid' })],
    });
  });

  it.each([{}, '1.2.3', true, 1, [null], [undefined], ['1.2.3', 0, false, true], [[], null, {}]])(
    'safely treats malformed observations %j as missing evidence', observations => {
      const request = input({
        observations: observations as unknown as EligibilityInput['observations'],
      });
      expect(evaluateEligibility(request)).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
        reasons: [expect.objectContaining({ code: 'harness_unverified', name: 'copilot' })],
      });
      expect(createEligibilityStore({ observations: request.observations }).pin()
        .evaluate({ ...request, observations: undefined })).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
      expect(evaluateEligibility({ ...request, harnesses: [] })).toMatchObject({
        status: 'eligible', admitted: true, harness: 'unconstrained',
      });
    },
  );

  it('retains usable matching evidence despite unrelated malformed observation entries', () => {
    const observations = [null, 'unrelated', false, {}, [], input().observations![0]];
    expect(evaluateEligibility(input({
      observations: observations as unknown as EligibilityInput['observations'],
    }))).toMatchObject({ status: 'eligible', admitted: true, harness: 'compatible' });
  });

  it.each(['v1.2.3', '1.2', '01.2.3', '1.2.3-01', '1.2.3+', '1.2.3.4', ' 1.2.3'])(
    'fails closed for malformed semver %s', value => {
      expect(evaluateVersion(value, '2.0.0')).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
      expect(evaluateVersion('1.0.0', value)).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
    },
  );
  it.each(['^1.2.3', '>=1.2', '>=1.2.3 ||', '1.2.3', '>=1.2.3, <2.0.0', ''])(
    'does not invent semantics for malformed excluded range %s', range => {
      expect(evaluateVersion('1.0.0', '2.0.0', 'semver', [range])).toMatchObject({
        status: 'unknown', admitted: false,
      });
    },
  );

  it.each([null, false, 0, '', { minimum: '1.0.0' }, [null]])(
    'fails closed for malformed excluded-range containers %j', excludedRanges => {
      const request = input({ harnesses: [{ ...requirement, excludedRanges } as any] });
      expect(evaluateEligibility(request)).toMatchObject({
        status: 'unknown', admitted: false, harness: 'unverified',
      });
      if (excludedRanges && typeof excludedRanges === 'object') {
        expect(Object.isFrozen(excludedRanges)).toBe(false);
      }
    },
  );

  it.each([
    { provider: 'other', channel: 'copilot-api' },
    { provider: 'copilot', channel: 'copilot-cli' },
    { ...scope, deployment: 'production' },
  ])('does not broaden requirement scope %j', otherScope => {
    expect(evaluateEligibility(input({
      harnesses: [{ ...requirement, scope: otherScope }], observations: [],
    }))).toMatchObject({ admitted: true, harness: 'unconstrained' });
    expect(evaluateEligibility(input({
      observations: [{ ...input().observations![0], scope: otherScope }],
    }))).toMatchObject({ admitted: false, harness: 'unverified' });
  });

  it.each([
    { environment: 'host' }, { environment: 'chroot:run-1' }, { environment: 'guest:run-1' },
    { environment: undefined }, { verified: false }, { actual: false }, { verified: undefined },
    { scheme: 'numeric-components' }, { scheme: '' }, { scheme: false }, { scheme: 0 }, { scheme: null },
  ])('rejects missing or mismatched actual execution evidence %j', change => {
    expect(evaluateEligibility(input({
      observations: [{ ...input().observations![0], ...change } as any],
    }))).toMatchObject({ admitted: false, harness: 'unverified' });
  });

  it('does not accept an observation when the execution environment is unspecified', () => {
    expect(evaluateEligibility(input({ executionEnvironment: undefined })))
      .toMatchObject({ admitted: false, harness: 'unverified' });
  });

  it('retains sanitized provenance and requirements for successful harness evidence', () => {
    expect(evaluateEligibility(input()).reasons).toContainEqual({
      code: 'harness_compatible', scope, name: requirement.name,
      environment: 'container:run-1',
      required: { scheme: 'semver', minimum: '1.2.3', excludedRanges: [] },
      detected: '1.2.3', reason: requirement.reason,
      provenance: requirement.provenance,
    });
  });

  it('handles unmatched null identities without throwing or admission', () => {
    const request = input({ identity: null });
    expect(evaluateEligibility(request)).toMatchObject({ status: 'unknown', admitted: false });
    expect(createEligibilityStore().pin().evaluate(request))
      .toMatchObject({ status: 'unknown', admitted: false });
  });

  it('rejects duplicate exact model keys atomically at initialization and replacement', () => {
    const duplicate = {
      models: [
        { identity: model, harnesses: [requirement] },
        { identity: { ...model, family: 'other' }, harnesses: [{ ...requirement, minimum: '9.0.0' }] },
      ],
    };
    expect(() => createEligibilityStore(duplicate)).toThrow('Duplicate eligibility model key');
    const store = createEligibilityStore({ models: [duplicate.models[0]] });
    const before = store.pin();
    expect(() => store.replace(duplicate)).toThrow('Duplicate eligibility model key');
    const after = store.pin();
    expect(after.revision).toBe(before.revision);
    expect(after.evaluate(input())).toEqual(before.evaluate(input()));
  });

  it('combines multiple requirements and does not erase negative evidence', () => {
    expect(evaluateEligibility(input({
      harnesses: [requirement, { ...requirement, name: 'other', minimum: '99.0.0' }],
      observations: [{ ...input().observations![0], version: '1.0.0' }],
    }))).toMatchObject({ status: 'incompatible', admitted: false, harness: 'incompatible' });
  });

  it('honors policy and lifecycle independently and exactly scopes negative discovery', () => {
    for (const lifecycle of ['retired', 'removed'] as const) {
      expect(evaluateEligibility(input({ lifecycle: { status: lifecycle } })))
        .toMatchObject({ status: 'incompatible', admitted: false });
    }
    expect(evaluateEligibility(input({ policy: { status: 'deny' } })))
      .toMatchObject({ status: 'incompatible', admitted: false });
    expect(evaluateEligibility(input({
      policy: { status: 'deny', scope: { ...scope, deployment: 'other' } },
      discovery: { status: 'unavailable', authoritative: true, scope: { ...scope, channel: 'native-api' } },
    }))).toMatchObject({ status: 'unknown', admitted: true });
  });

  it('returns immutable owned diagnostics and strips credential-bearing provenance', () => {
    const source = new URL('https://example.com/compat');
    source.username = 'user';
    source.password = 'password';
    source.search = '?token=credential';
    source.hash = 'fragment';
    const request = input({
      observations: [],
      harnesses: [{
        ...requirement,
        provenance: {
          authority: 'maintained',
          source: source.toString(),
          revision: 'r1', token: 'credential', nested: { password: 'credential' },
        },
      }],
    });
    const before = JSON.stringify(request);
    const result = evaluateEligibility(request);
    expect(JSON.stringify(request)).toBe(before);
    expect(result.reasons[0]).toMatchObject({
      code: 'harness_unverified', scope, name: 'copilot',
      required: { scheme: 'semver', minimum: '1.2.3', excludedRanges: [] },
      provenance: { authority: 'maintained', source: 'https://example.com/compat', revision: 'r1' },
    });
    expect(JSON.stringify(result)).not.toMatch(/credential|user:password|nested/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.reasons[0].required!.excludedRanges)).toBe(true);
    expect(Object.isFrozen(request.harnesses![0])).toBe(false);
    expect(evaluateEligibility(request)).toEqual(result);
  });

  it('pins model and observation revisions without family or provider bleed', () => {
    const state = {
      models: [{ identity: { ...model, family: 'family' }, harnesses: [requirement] }],
      observations: input().observations, executionEnvironment: 'container:run-1',
    };
    const store = createEligibilityStore(state);
    const first = store.pin();
    state.models[0].harnesses[0] = { ...requirement, minimum: '9.0.0' };
    const request = { identity: model, scope, discovery: input().discovery };
    expect(first.evaluate(request)).toMatchObject({ admitted: true, harness: 'compatible' });
    store.replace(state);
    expect(first.revision).toBe(0);
    expect(store.pin().revision).toBe(1);
    expect(first.evaluate(request).admitted).toBe(true);
    expect(store.pin().evaluate(request).admitted).toBe(false);
    for (const other of [identity('copilot', 'family'), identity('other', model.rawId)]) {
      expect(store.pin().evaluate({
        ...request, identity: other, scope: { ...scope, provider: other.provider },
      })).toMatchObject({ admitted: true, harness: 'unconstrained' });
    }
    expect(Object.isFrozen(first)).toBe(true);
  });
});
