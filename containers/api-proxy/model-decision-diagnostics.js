'use strict';

const Ajv = require('ajv');
const schema = require('./model-decision-diagnostics.schema.json');

const validateDiagnostics = new Ajv({ strict: true }).compile(schema);
const MAX_CURRENT = 64;
const MAX_RECENT = 32;
const RETENTION_SECONDS = 900;
const PROVIDERS = new Set(['openai', 'anthropic', 'copilot', 'gemini', 'vertex']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const CONTEXTS = new Set(['primary-agent', 'dedicated-enclave', 'unknown']);
const ADVICE = Object.freeze({
  policy_denied: ['rejected', 'change_request', 'do_not_repeat',
    'Model policy rejected this decision. Do not repeat the unchanged request or infer permission from missing metadata.'],
  provider_not_configured: ['unavailable', 'operator_required', 'after_operator_change',
    'This provider is not configured in this proxy. Request changes alone do not configure it.'],
  discovery_pending: ['unknown', 're_evaluate', 'after_models_fetch',
    'Startup model discovery is not complete. Re-evaluate after models_fetch_complete becomes true; success is not guaranteed.'],
  provider_state_unknown: ['unknown', 'unknown', 'unknown',
    'Model listings alone do not establish runtime availability or request eligibility. A missing listing is not confirmed unavailability.'],
  capability_snapshot: ['unknown', 'unknown', 'unknown',
    'These are current, explicitly advertised effort values, not a captured admission decision or proof of full eligibility.'],
  automatic_selection_no_candidates: ['unknown', 'unknown', 'unknown',
    'The existing automatic-selection result has no approved candidates. It does not identify a single rejection cause.'],
  unsupported_reasoning_effort: ['rejected', 'change_request', 'do_not_repeat',
    'AWF rejected a known unsupported effort. Do not repeat it unchanged. A valid correction requires exact-model, endpoint-scoped evidence; omission semantics are unknown.'],
  harness_incompatible: ['rejected', 'operator_required', 'after_operator_change',
    'Captured evidence shows an incompatible harness. A compatible harness and trusted evidence in the actual execution environment are required.'],
  harness_unverified: ['unknown', 'operator_required', 'after_operator_change',
    'Compatible harness evidence is missing, unverified, or incorrectly scoped. Primary-agent evidence cannot establish enclave compatibility.'],
  harness_constraint_invalid: ['unknown', 'operator_required', 'after_operator_change',
    'The harness constraint is invalid. An operator must supply valid trusted evidence before re-evaluation.'],
  harness_selection_invalid: ['unknown', 'operator_required', 'after_operator_change',
    'The trusted harness selection is invalid. Request headers cannot establish the actual execution harness.'],
  harness_observation_invalid: ['unknown', 'operator_required', 'after_operator_change',
    'The harness observation is invalid. An operator must supply verified execution-environment evidence.'],
  lifecycle_retired: ['rejected', 'change_request', 'do_not_repeat',
    'Captured lifecycle evidence marks the model retired. Do not repeat the unchanged request.'],
  lifecycle_removed: ['rejected', 'change_request', 'do_not_repeat',
    'Captured lifecycle evidence marks the model removed. Do not repeat the unchanged request.'],
  discovery_unavailable: ['unavailable', 'unknown', 'unknown',
    'Captured authoritative, scoped discovery evidence marks this model unavailable. No valid replacement or retry condition is known.'],
  discovery_unknown: ['unknown', 'unknown', 'unknown',
    'Discovery does not establish availability in this scope. Unknown evidence is neither denial nor permission.'],
  identity_scope_mismatch: ['unknown', 'unknown', 'unknown',
    'Identity and scope could not be verified. No valid action can be inferred.'],
  routing_selected: ['observed', 'none', 'not_applicable',
    'The existing routing result selected this model. It is advisory, not permission or a new eligibility evaluation.'],
  no_route: ['unknown', 'unknown', 'unknown',
    'Routing found no eligible choice. The summary does not establish whether policy, capability, or discovery caused it.'],
  provider_unavailable: ['unavailable', 'unknown', 'unknown',
    'The existing runtime path reported provider unavailability. This does not establish permanent model removal or a guaranteed retry.'],
  routing_policy_violation: ['unknown', 'unknown', 'do_not_repeat',
    'Routing reported a policy violation. The summary does not identify a rejected request or whether AWF or the provider supplied the reason. Do not repeat unchanged routing input.'],
  routing_provider_unavailable: ['unknown', 'unknown', 'unknown',
    'Routing reported provider_unavailable, which can also mean missing catalogue evidence. Actual provider availability and a valid retry condition are unknown.'],
  routing_timeout: ['unavailable', 'unknown', 'unknown',
    'The routing deadline elapsed. This summary supplies no authorized retry condition.'],
  routing_configuration_error: ['unavailable', 'operator_required', 'after_operator_change',
    'Routing configuration or bootstrap failed. Operator intervention is required before re-evaluation.'],
  routing_contract_error: ['unavailable', 'operator_required', 'after_operator_change',
    'The routing contract failed. Request changes alone are not a known repair.'],
  pricing_resolution_error: ['unavailable', 'operator_required', 'after_operator_change',
    'AI-credit accounting failed. Do not treat unavailable accounting as zero cost or continue by guessing a price.'],
  direct_pricing: ['observed', 'none', 'not_applicable',
    'Existing AI-credit accounting reports directly priced usage. Read totals from ai_credits; no price was recalculated.'],
  estimated_pricing: ['estimated', 'none', 'not_applicable',
    'Existing AI-credit accounting used an estimate. Estimated charges still count toward budgets; they do not establish capability or eligibility.'],
  fallback_pricing: ['estimated', 'none', 'not_applicable',
    'Existing AI-credit accounting used fallback pricing. It still counts toward budgets and is not proof of exact-model pricing.'],
  pricing_unknown: ['unknown', 'unknown', 'unknown',
    'The available accounting summary does not establish a pricing basis. Missing usage is not zero cost.'],
  decision_unknown: ['unknown', 'unknown', 'unknown',
    'The captured summary supplies no recognized model-decision evidence. No valid action or retry can be inferred.'],
});

function endpointFor(value) {
  if (typeof value !== 'string') return null;
  const path = value.replace(/^\/v1\//, '/');
  if (path === '/messages' || path === 'messages') return '/v1/messages';
  if (['/responses', 'responses'].includes(path)) return '/responses';
  if (['/chat/completions', 'chat/completions', 'chat_completions'].includes(path)) return '/chat/completions';
  return null;
}

function modelId(value) {
  return typeof value === 'string' && value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value) ? value : null;
}

function revision(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null;
}

function observedAt(value) {
  return typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) ? value : null;
}

function decision(reason, { kind = 'current_state', provider = null, model = null,
  context = 'unknown', endpoint = null, source = 'reflection', eligibilityRevision,
  catalogueRevision, observed } = {}) {
  const [status, action, retry, explanation] = Object.hasOwn(ADVICE, reason)
    ? ADVICE[reason] : ADVICE.decision_unknown;
  const knownProvider = PROVIDERS.has(provider) ? provider : null;
  return {
    kind,
    identity: { provider: knownProvider, model_id: modelId(model) },
    scope: { context: CONTEXTS.has(context) ? context : 'unknown',
      channel: knownProvider ? (knownProvider === 'copilot' ? 'copilot-api' : 'native-api') : null,
      endpoint: endpointFor(endpoint) },
    status, reason: Object.hasOwn(ADVICE, reason) ? reason : 'decision_unknown', explanation,
    action: { kind: action, retry },
    evidence: { source,
      eligibility_revision: Number.isSafeInteger(eligibilityRevision) && eligibilityRevision >= 0 ? eligibilityRevision : null,
      catalogue_revision: revision(catalogueRevision), observed_at: observedAt(observed) },
  };
}

function effortEvidence(values, endpoint, unsupported = false) {
  const supported = Array.isArray(values) && values.length <= EFFORTS.size &&
    values.every(value => EFFORTS.has(value)) ? [...new Set(values)] : null;
  return {
    support: unsupported ? 'known_unsupported' : supported?.length ? 'reported_supported' : 'unknown',
    supported_values: supported,
    field: { '/responses': 'reasoning.effort', '/chat/completions': 'reasoning_effort',
      '/v1/messages': 'output_config.effort' }[endpointFor(endpoint)] || null,
    omission_supported: null,
  };
}

// Only the already policy-filtered public inventory may name a model. Opaque,
// disallowed, and deployment-qualified IDs are never echoed from observations.
function visibleIdentity(provider, model, endpoints) {
  return modelId(model) && endpoints.some(endpoint => endpoint.provider === provider &&
    endpoint.models?.includes(model)) ? model : null;
}

function projectCapturedEligibility(captured, context) {
  const result = captured.decision;
  if (!result || result.scope?.deployment !== undefined || result.scope?.provider !== captured.provider ||
      result.scope?.channel !== (captured.provider === 'copilot' ? 'copilot-api' : 'native-api')) return [];
  return (Array.isArray(result.reasons) ? result.reasons : []).slice(0, 16)
    .filter(reason => Object.hasOwn(ADVICE, reason?.code))
    .map(reason => decision(reason.code, {
      kind: 'request_outcome', provider: captured.provider, context,
      endpoint: captured.endpoint, source: 'eligibility',
      eligibilityRevision: captured.eligibilityRevision, catalogueRevision: captured.catalogueRevision,
      observed: captured.observedAt,
    }));
}

function projectModelDecisionDiagnostics(reflection, { context = 'unknown', recent = null,
  runtimeMetadata = {} } = {}) {
  context = CONTEXTS.has(context) ? context : 'unknown';
  const endpoints = Array.isArray(reflection.endpoints) ? reflection.endpoints : [];
  const current = [];
  for (const endpoint of endpoints) {
    if (!PROVIDERS.has(endpoint.provider)) continue;
    const base = { provider: endpoint.provider, context };
    current.push(decision(endpoint.configured === false ? 'provider_not_configured'
      : reflection.models_fetch_complete === false ? 'discovery_pending' : 'provider_state_unknown', base));
    // Copy only explicit exact runtime advertisements. Maintained/family routing
    // fallbacks must not become reasoning-support evidence in this projection.
    if (context === 'primary-agent' && endpoint.configured === true) {
      for (const record of runtimeMetadata[endpoint.provider] || []) {
        if (current.length > MAX_CURRENT) break;
        const model = visibleIdentity(endpoint.provider, record?.id, endpoints);
        if (!model || !Array.isArray(record.supportedReasoningEfforts) ||
            !Array.isArray(record.supportedEndpoints)) continue;
        for (const normalized of new Set(record.supportedEndpoints.map(endpointFor).filter(Boolean))) {
          current.push({
            ...decision('capability_snapshot', { ...base, model, endpoint: normalized, observed: record.observedAt }),
            effort: effortEvidence(record.supportedReasoningEfforts, normalized),
          });
        }
      }
    }
    const candidates = endpoint.automatic_model_selection?.candidates;
    if (candidates && Object.values(candidates).every(group =>
      Object.values(group).every(values => Array.isArray(values) && values.length === 0))) {
      current.push(decision('automatic_selection_no_candidates', base));
    }
  }
  if (reflection.routing?.status === 'failed') {
    const code = reflection.routing.failure_code;
    current.push(decision(code === 'model_policy_violation' ? 'routing_policy_violation'
      : code === 'provider_unavailable' ? 'routing_provider_unavailable' : code,
      { context, source: 'routing' }));
  } else if (reflection.routing?.status === 'selected') {
    const selection = reflection.routing.selection;
    current.push(decision('routing_selected', { context, source: 'routing', provider: selection?.provider,
      model: visibleIdentity(selection?.provider, selection?.wire_model, endpoints), endpoint: selection?.endpoint }));
  }

  const accounting = [];
  // The dedicated proxy is shared by invocations: its aggregate buckets cannot
  // establish the querying enclave's usage or execution-environment evidence.
  if (context === 'primary-agent') {
    if (reflection.ai_credits?.pricing_error === 'pricing_resolution_error') {
      accounting.push(decision('pricing_resolution_error', {
        kind: 'accounting_summary', context: 'unknown', source: 'ai_credits',
      }));
    }
    for (const [key, usage] of Object.entries(reflection.ai_credits?.by_model || {}).slice(0, MAX_CURRENT + 1)) {
      const slash = key.indexOf('/');
      const provider = slash > 0 ? key.slice(0, slash) : null;
      const model = slash > 0 ? key.slice(slash + 1) : null;
      const estimate = usage?.pricing_estimate;
      const basis = estimate?.basis === 'family' ? 'family'
        : estimate?.basis === 'backend' ? 'backend' : estimate ? 'unknown'
          : usage?.fallback_pricing_used === true ? 'fallback'
            : ['operator', 'shared_catalog', 'provider', 'central_feed', 'curated', 'models.dev']
              .includes(usage?.pricing_source) ? 'direct' : 'unknown';
      const reason = estimate ? 'estimated_pricing' : basis === 'fallback' ? 'fallback_pricing'
        : basis === 'direct' ? 'direct_pricing' : 'pricing_unknown';
      accounting.push({
        ...decision(reason, { kind: 'accounting_summary', provider, context: 'unknown', source: 'ai_credits',
          model: visibleIdentity(provider, model, endpoints), catalogueRevision: usage?.pricing_catalog_version }),
        pricing: { basis,
          donor_count: Number.isSafeInteger(estimate?.donorCount) && estimate.donorCount >= 0 ? estimate.donorCount : null,
          budget_accounted: typeof usage?.total === 'number' && Number.isFinite(usage.total) ? true : null },
      });
    }
  }
  const captured = context === 'primary-agent' && Array.isArray(recent) ? recent.slice(-MAX_RECENT) : [];
  const projectedRecent = captured.map(item => ({
    ...decision(item.reason, { kind: 'request_outcome', provider: item.provider, context, source: 'awf_response',
      model: visibleIdentity(item.provider, item.model, endpoints), endpoint: item.endpoint,
      eligibilityRevision: item.eligibilityRevision, catalogueRevision: item.catalogueRevision, observed: item.observedAt }),
    ...(item.rejected === true ? { status: 'rejected' } : {}),
    ...(item.reason === 'unsupported_reasoning_effort' ? { effort: effortEvidence(null, item.endpoint, true) } : {}),
    occurrences: Number.isSafeInteger(item.occurrences) ? Math.max(1, Math.min(1000, item.occurrences)) : 1,
  }));
  let snapshotBudget = Math.max(0, MAX_CURRENT - current.filter(item =>
    item.reason !== 'capability_snapshot').length);
  const boundedCurrent = current.filter(item =>
    item.reason !== 'capability_snapshot' || snapshotBudget-- > 0).slice(0, MAX_CURRENT);
  const output = {
    schema: 'awf-model-decision-diagnostics/v1', context,
    current: { decisions: boundedCurrent, truncated: boundedCurrent.length < current.length },
    recent: { status: context === 'primary-agent' && Array.isArray(recent) ? 'available' : 'unavailable',
      decisions: projectedRecent, limit: MAX_RECENT, retention_seconds: RETENTION_SECONDS },
    accounting: { decisions: accounting.slice(0, MAX_CURRENT), truncated: accounting.length > MAX_CURRENT },
  };
  if (!validateDiagnostics(output)) throw new Error('Invalid model decision diagnostics projection');
  return output;
}

module.exports = {
  MAX_RECENT, RETENTION_SECONDS, decision, endpointFor, modelId, revision, observedAt,
  projectCapturedEligibility, projectModelDecisionDiagnostics, validateDiagnostics,
};
