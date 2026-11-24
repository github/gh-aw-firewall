'use strict';

const { createHash } = require('crypto');

function safeRecord(observer, record) {
  try {
    observer?.record?.(Object.freeze(record));
  } catch {
    // Observability must not change the routing decision.
  }
}

function recordClassifierAttempt(observer, { purpose, attempt, mapping }) {
  safeRecord(observer, {
    stage: 'classification',
    purpose,
    attempt,
    classifier_model: mapping.choice.model,
    classifier_effort: mapping.effort ?? null,
  });
}

function recordSelection(observer, {
  config, selection, classification, successfulClassifier, rawCapabilities, route,
  conversation, degradedReason, actualAttempts, pool, catalogueOverlap, clock, startedAt,
  selectionSource, fallbackReason, fallbackTier,
}) {
  const resolvedSource = selectionSource || selection.selection_source || 'router';
  const resolvedFallbackReason = fallbackReason !== undefined
    ? fallbackReason
    : (selection.fallback_reason ?? null);
  const resolvedFallbackTier = fallbackTier !== undefined
    ? fallbackTier
    : (selection.fallback_tier ?? null);
  const router = rawCapabilities &&
    typeof rawCapabilities.name === 'string' &&
    typeof rawCapabilities.version === 'string'
    ? { name: rawCapabilities.name, version: rawCapabilities.version }
    : null;
  const rankedChoices = Array.isArray(route?.ranked_choices)
    ? route.ranked_choices.map(choice => ({
      model: choice.model,
      effort: choice.effort ?? null,
    }))
    : null;
  safeRecord(observer, {
    stage: 'selection',
    objective: config.objective,
    provider: config.provider || 'copilot',
    selected_provider: selection.provider,
    wire_model: selection.wire_model,
    endpoint: selection.endpoint,
    selection_source: resolvedSource,
    fallback_reason: resolvedFallbackReason,
    fallback_tier: resolvedFallbackTier,
    labels: classification?.labels ?? null,
    mode: classification?.mode ?? null,
    classifier_model: successfulClassifier?.model ?? null,
    classifier_effort: successfulClassifier?.effort ?? null,
    router,
    ranked_choices: rankedChoices,
    conversation_sha256: createHash('sha256').update(JSON.stringify(conversation)).digest('hex'),
    selected_id: selection.choice.id,
    selected_model: selection.choice.model,
    selected_effort: selection.choice.effort ?? null,
    degraded_classification: classification === null,
    degraded_reason: degradedReason ?? null,
    classifier_attempts: actualAttempts ?? 0,
    eligible_choices: pool.choices.length,
    catalogue_overlap: catalogueOverlap ?? null,
    latency_ms: Math.max(0, clock.now() - startedAt),
  });
}

function recordFailure(observer, { config, failure, catalogueOverlap, clock, startedAt }) {
  safeRecord(observer, {
    stage: 'failure',
    objective: config?.objective ?? null,
    code: failure.code,
    // Routing failure details are authored literals, already sanitized by toRoutingFailure.
    detail: failure.detail,
    catalogue_overlap: catalogueOverlap,
    latency_ms: Math.max(0, clock.now() - startedAt),
  });
}

module.exports = { recordClassifierAttempt, recordSelection, recordFailure };
