'use strict';

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

function sameScope(left, right) {
  return !!left && !!right && left.provider === right.provider &&
    left.channel === right.channel && left.deployment === right.deployment;
}

function provenance(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  for (const field of ['authority', 'source', 'revision', 'catalogId', 'catalogVersion',
    'at', 'freshUntil', 'confidence', 'freshness', 'stale']) {
    const item = value[field];
    if (field === 'stale' && typeof item === 'boolean') result[field] = item;
    if (typeof item !== 'string' || /[\r\n]/.test(item)) continue;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(item)) {
      try {
        const url = new URL(item);
        if (!['https:', 'http:'].includes(url.protocol)) continue;
        url.username = '';
        url.password = '';
        url.pathname = '/';
        url.search = '';
        url.hash = '';
        result[field] = url.toString();
      } catch { /* Invalid provenance URLs are not diagnostic evidence. */ }
    } else if (!/(?:bearer|password|token|secret|api[_-]?key)\s*[:= ]/i.test(item)) {
      result[field] = item;
    }
  }
  return result;
}

function version(value, scheme) {
  if (typeof value !== 'string') return null;
  if (scheme === 'numeric-components') {
    return /^(0|[1-9]\d*)(\.(0|[1-9]\d*))*$/.test(value)
      ? { core: value.split('.').map(BigInt), pre: [] } : null;
  }
  if (scheme !== 'semver') return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value);
  if (!match) return null;
  const pre = match[4] ? match[4].split('.') : [];
  if (pre.some(part => /^\d+$/.test(part) && !/^(0|[1-9]\d*)$/.test(part))) return null;
  return { core: match.slice(1, 4).map(BigInt), pre };
}

function compare(left, right) {
  for (let i = 0; i < Math.max(left.core.length, right.core.length); i++) {
    const a = left.core[i] || 0n;
    const b = right.core[i] || 0n;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (!left.pre.length || !right.pre.length) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const a = left.pre[i];
    const b = right.pre[i];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a);
    const numericB = /^\d+$/.test(b);
    if (numericA && numericB) return BigInt(a) < BigInt(b) ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

// Only explicit comparators, whitespace conjunctions and || disjunctions are supported.
function range(value, scheme) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const alternatives = value.split('||').map(part => {
    if (!part.trim()) return null;
    return part.trim().split(/\s+/).map(term => {
      const match = /^(<=|>=|<|>|=)(.+)$/.exec(term);
      const parsed = match && version(match[2], scheme);
      return parsed ? { operator: match[1], version: parsed } : null;
    });
  });
  return alternatives.some(parts => !parts || parts.some(part => !part)) ? null : alternatives;
}

function inRange(detected, alternatives) {
  return alternatives.some(parts => parts.every(part => {
    const order = compare(detected, part.version);
    return { '<': order < 0, '<=': order <= 0, '>': order > 0,
      '>=': order >= 0, '=': order === 0 }[part.operator];
  }));
}

function evaluateEligibility(input) {
  const { identity, scope, discovery, lifecycle, policy, executionEnvironment, selectedHarness } = input;
  const knownSelection = typeof selectedHarness === 'string' && selectedHarness.trim().length > 0;
  const invalidSelection = selectedHarness !== undefined && !knownSelection;
  const reasons = [];
  let incompatible = false;
  let unknown = false;
  let harness = 'unconstrained';
  const add = (code, evidence = {}, requirement, detected) => {
    const item = { code, scope: { ...scope } };
    if (requirement) {
      if (typeof requirement.name === 'string') item.name = requirement.name;
      item.required = {
        scheme: typeof requirement.scheme === 'string' ? requirement.scheme : undefined,
        minimum: typeof requirement.minimum === 'string' ? requirement.minimum : undefined,
        excludedRanges: Array.isArray(requirement.excludedRanges)
          ? requirement.excludedRanges.filter(value => typeof value === 'string') : [],
      };
      if (typeof executionEnvironment === 'string') item.environment = executionEnvironment;
    }
    if (typeof detected === 'string') item.detected = detected;
    if (typeof evidence.reason === 'string') item.reason = evidence.reason;
    const source = provenance(evidence.provenance);
    if (source) item.provenance = source;
    reasons.push(item);
  };
  const applies = evidence => evidence && (!evidence.scope || sameScope(evidence.scope, scope));
  if (!identity || !scope || identity.provider !== scope.provider) {
    unknown = true;
    add('identity_scope_mismatch');
  }
  if (applies(policy) && policy.status === 'deny') {
    incompatible = true;
    add('policy_denied', policy);
  }
  if (applies(lifecycle) && ['retired', 'removed'].includes(lifecycle.status)) {
    incompatible = true;
    add(`lifecycle_${lifecycle.status}`, lifecycle);
  }
  if (applies(discovery) && discovery.status === 'unavailable' && discovery.authoritative === true) {
    incompatible = true;
    add('discovery_unavailable', discovery);
  } else if (!applies(discovery) || discovery.status !== 'available' || discovery.authoritative !== true) {
    unknown = true;
    add('discovery_unknown', applies(discovery) ? discovery : {});
  }
  for (const requirement of input.harnesses || []) {
    if (!sameScope(requirement.scope, scope)) continue;
    const validName = typeof requirement.name === 'string' && requirement.name.trim().length > 0;
    if (knownSelection && validName && requirement.name !== selectedHarness) continue;
    if (harness === 'unconstrained') harness = 'compatible';
    if (invalidSelection) {
      unknown = true;
      if (harness !== 'incompatible') harness = 'unverified';
      add('harness_selection_invalid', requirement, requirement);
      continue;
    }
    const minimum = version(requirement.minimum, requirement.scheme);
    const rawExcluded = requirement.excludedRanges === undefined ? [] : requirement.excludedRanges;
    const excluded = Array.isArray(rawExcluded)
      ? rawExcluded.map(item => range(item, requirement.scheme)) : [null];
    if (!validName || !minimum || excluded.some(item => !item)) {
      unknown = true;
      if (harness !== 'incompatible') harness = 'unverified';
      add('harness_constraint_invalid', requirement, requirement);
      continue;
    }
    const observations = (Array.isArray(input.observations) ? input.observations : []).filter(observation =>
      observation && typeof observation === 'object' && !Array.isArray(observation) &&
      observation.name === requirement.name && sameScope(observation.scope, scope) &&
      typeof executionEnvironment === 'string' && executionEnvironment.length > 0 &&
      observation.environment === executionEnvironment && observation.verified === true &&
      observation.actual === true);
    if (!observations.length) {
      unknown = true;
      if (harness !== 'incompatible') harness = 'unverified';
      add('harness_unverified', requirement, requirement);
      continue;
    }
    for (const observation of observations) {
      const detected = (observation.scheme === undefined || observation.scheme === requirement.scheme) &&
        version(observation.version, requirement.scheme);
      if (!detected) {
        unknown = true;
        if (harness !== 'incompatible') harness = 'unverified';
        add('harness_observation_invalid', requirement, requirement, observation.version);
      } else if (compare(detected, minimum) < 0 || excluded.some(item => inRange(detected, item))) {
        incompatible = true;
        harness = 'incompatible';
        add('harness_incompatible', requirement, requirement, observation.version);
      } else {
        add('harness_compatible', requirement, requirement, observation.version);
      }
    }
  }
  return freeze({
    identity: identity ? { key: identity.key, provider: identity.provider, rawId: identity.rawId,
      lookupId: identity.lookupId } : null,
    scope: { ...scope }, status: incompatible ? 'incompatible' : unknown ? 'unknown' : 'eligible',
    admitted: !incompatible && harness !== 'unverified' && !!identity && !!scope &&
      identity.provider === scope.provider, reasons, harness,
    ...(knownSelection ? { selectedHarness } : {}),
  });
}

function createEligibilityStore(initial = {}) {
  let revision = 0;
  const prepare = next => {
    const cloned = structuredClone(next);
    const keys = new Set();
    for (const model of cloned.models || []) {
      const key = model && model.identity && model.identity.key;
      if (typeof key !== 'string' || !key) throw new Error('Invalid eligibility model identity key');
      if (keys.has(key)) throw new Error(`Duplicate eligibility model key: ${key}`);
      keys.add(key);
    }
    return freeze(cloned);
  };
  let state = prepare(initial);
  return Object.freeze({
    pin() {
      const pinned = state;
      return Object.freeze({
        revision,
        evaluate(input) {
          const model = input.identity &&
            (pinned.models || []).find(item => item.identity.key === input.identity.key);
          return evaluateEligibility({
            ...input,
            harnesses: [...(model ? model.harnesses || [] : []), ...(input.harnesses || [])],
            observations: input.observations === undefined ? pinned.observations : input.observations,
            executionEnvironment: input.executionEnvironment === undefined
              ? pinned.executionEnvironment : input.executionEnvironment,
            selectedHarness: input.selectedHarness === undefined
              ? pinned.selectedHarness : input.selectedHarness,
          });
        },
      });
    },
    replace(next) {
      state = prepare(next);
      revision++;
    },
  });
}

module.exports = { evaluateEligibility, createEligibilityStore };
