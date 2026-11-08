'use strict';

const { isDeepStrictEqual } = require('node:util');

const UNDERSTOOD_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const AUTHORITIES = { provider: 2, maintained: 1 };

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function provenance(value = {}) {
  if (!value || typeof value !== 'object') return {};
  return Object.fromEntries(['authority', 'source', 'revision', 'at', 'apiVersion', 'field']
    .filter(key => typeof value[key] === 'string')
    .map(key => [key, value[key].replace(/\p{Cc}/gu, '').slice(0, 512)]));
}

function sameScope(left, right) {
  return left?.provider === right.provider && left?.channel === right.channel &&
    left?.deployment === right.deployment;
}

// Inputs are exact, captured facts, not names, family rules or live stores.
function resolveReasoning({ identity, scope, facts = [] }) {
  const reasons = [];
  const applicable = [];
  for (const fact of facts) {
    if (!fact || typeof fact !== 'object') {
      reasons.push({ code: 'reasoning_malformed_fact' });
      continue;
    }
    let code;
    if (!identity || identity.provider !== scope.provider ||
        fact.identity?.key !== identity.key || fact.identity?.provider !== identity.provider) {
      code = 'reasoning_identity_mismatch';
    } else if (!sameScope(fact.scope, scope)) code = 'reasoning_scope_mismatch';
    else if (fact.active !== true) code = 'reasoning_inactive_fact';
    else if (!Object.hasOwn(AUTHORITIES, fact.authority)) code = 'reasoning_unreviewed_authority';
    if (code) reasons.push({ code });
    else applicable.push(fact);
  }
  const priority = Math.max(0, ...applicable.map(fact => AUTHORITIES[fact.authority]));
  const selected = applicable.filter(fact => AUTHORITIES[fact.authority] === priority);
  const observations = applicable.map(fact => ({
    authority: fact.authority,
    rawEfforts: Array.isArray(fact.rawEfforts) ? fact.rawEfforts.filter(value => typeof value === 'string') : [],
    provenance: provenance(fact.provenance),
    selected: selected.includes(fact),
  }));
  let support = selected.length ? 'unknown' : 'absent';
  let mode = 'unknown';
  let supportedEfforts = [];
  let defaultEffort;
  if (selected.length) {
    const fact = selected[0];
    const signature = value => ({
      support: value.support, rawEfforts: value.rawEfforts, mode: value.mode, default: value.default,
    });
    const conflicting = selected.some(value => !isDeepStrictEqual(signature(value), signature(fact)));
    const rawEfforts = Array.isArray(fact.rawEfforts)
      ? fact.rawEfforts.filter(value => typeof value === 'string' && value.length > 0) : [];
    const effortsValid = Array.isArray(fact.rawEfforts) &&
      (fact.rawEfforts.length === 0 || rawEfforts.length > 0);
    if (effortsValid && rawEfforts.length !== fact.rawEfforts.length) {
      reasons.push({ code: 'reasoning_malformed_effort_ignored' });
    }
    const malformed = !['supported', 'unsupported', 'unknown', 'conditional'].includes(fact.support) ||
      (fact.rawEfforts !== undefined && !effortsValid) ||
      (fact.support === 'supported' && (!effortsValid || fact.rawEfforts.length === 0)) ||
      (fact.support === 'unsupported' && fact.rawEfforts?.length > 0) ||
      (fact.mode !== undefined && !['optional', 'required', 'forbidden', 'unknown'].includes(fact.mode)) ||
      (fact.mode === 'forbidden' && fact.support === 'supported') ||
      (fact.mode === 'required' && fact.support === 'unsupported');
    if (conflicting || malformed) {
      reasons.push({ code: conflicting ? 'reasoning_conflicting_facts' : 'reasoning_malformed_fact' });
    } else {
      support = fact.support === 'conditional' ? 'unknown' : fact.support;
      mode = fact.mode || 'unknown';
      if (support === 'supported') supportedEfforts = [...new Set(rawEfforts)];
      if (fact.default !== undefined) {
        if (typeof fact.default === 'string' && supportedEfforts.includes(fact.default) && mode !== 'forbidden') {
          defaultEffort = fact.default;
        } else reasons.push({ code: 'reasoning_invalid_default' });
      }
      if (fact.support === 'conditional') reasons.push({ code: 'reasoning_condition_unverified' });
    }
  }
  reasons.push({ code: `reasoning_support_${support}` });
  if (supportedEfforts.some(effort => !UNDERSTOOD_EFFORTS.has(effort))) {
    reasons.push({ code: 'reasoning_future_effort_not_selectable' });
  }
  return freeze({
    identity: identity ? { key: identity.key, provider: identity.provider, rawId: identity.rawId } : null,
    scope: { ...scope }, support, mode, supportedEfforts,
    selectableEfforts: supportedEfforts.filter(effort => UNDERSTOOD_EFFORTS.has(effort)),
    ...(defaultEffort === undefined ? {} : { default: defaultEffort }),
    observations, reasons,
  });
}

function assessReasoningEffort(decision, effort, { automatic = false } = {}) {
  let code;
  if (effort === undefined) {
    if (decision.mode === 'required') code = 'reasoning_effort_required';
    else if (automatic && decision.support !== 'unsupported' &&
        !(decision.support === 'supported' && decision.mode === 'optional')) {
      code = 'reasoning_automatic_requires_known_support';
    }
  } else if (decision.mode === 'forbidden' || decision.support === 'unsupported') {
    code = 'reasoning_effort_forbidden';
  } else if (decision.support === 'supported' && !decision.supportedEfforts.includes(effort)) {
    code = 'reasoning_effort_unsupported';
  } else if (automatic && decision.support !== 'supported') {
    code = 'reasoning_automatic_requires_known_support';
  } else if (automatic && !decision.selectableEfforts.includes(effort)) {
    code = 'reasoning_future_effort_not_selectable';
  }
  return freeze({
    admitted: !code,
    reasons: [{ code: code || (['unknown', 'absent'].includes(decision.support)
      ? 'reasoning_direct_unknown_passthrough' : 'reasoning_effort_accepted') }],
  });
}

module.exports = { resolveReasoning, assessReasoningEffort };
