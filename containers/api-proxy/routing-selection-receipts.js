'use strict';

const { PRICE, selectAdaptive } = require('./adaptive-select');
const { deepFreezeJson } = require('./routing-stages');

// Controller-owned reasons written when a valid summary yields to ordinary routing or fallback;
// kept out of ADAPTIVE_REASONS because that list is the pure selector's oracle vocabulary.
const ADAPTIVE_FALLBACK_REASONS = Object.freeze({
  SELECTION_REJECTED: 'selection_rejected',
  ROUTER_FALLBACK: 'router_fallback',
});

function resolveAdaptiveLevel(summary, objectiveMode, classification) {
  if (objectiveMode !== 'auto' || !summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return undefined;
  }
  if (!Object.hasOwn(summary, 'level') || summary.level !== 'auto') {
    return undefined;
  }
  const classifiedMode = classification?.mode;
  return typeof classifiedMode === 'string' && Object.hasOwn(PRICE, classifiedMode)
    ? classifiedMode
    : 'balanced';
}

function createOrdinaryAdaptiveReceipt({ job, summary }, pair, reason) {
  return {
    event: 'adaptive_selection',
    v: 2,
    workflow: job.workflow,
    run: { id: job.run_id, attempt: job.attempt },
    generation: summary.generation,
    mode: summary.mode,
    scope: summary.scope,
    role: 'ordinary',
    explore_allowed: summary.explore.allowed === true && job.attempt === 1,
    selected: pair,
    ordinary: pair,
    would: null,
    incumbent: { before: summary.incumbent, after: summary.incumbent },
    costs: {},
    concurrency: {
      turn: summary.explore.turn,
      in_flight: summary.explore.in_flight,
      capacity: null,
    },
    reason,
  };
}

function modelEffortPair(choice) {
  return {
    model: choice.model,
    ...(Object.hasOwn(choice, 'effort') ? { effort: choice.effort } : {}),
  };
}

function createSelection(choice, mapping, metadata = {}) {
  const selectionSource = metadata.selectionSource || 'router';
  const fallbackReason = metadata.fallbackReason ?? null;
  const fallbackTier = metadata.fallbackTier ?? null;
  return deepFreezeJson({
    schema: 'awf-routing-selection/v1',
    engine: 'copilot',
    provider: mapping.provider,
    choice: { id: choice.id, ...modelEffortPair(choice) },
    wire_model: mapping.wireModel,
    endpoint: {
      responses: '/responses',
      'chat-completions': '/chat/completions',
      messages: '/v1/messages',
    }[mapping.protocol],
    selection_source: selectionSource,
    fallback_reason: fallbackReason,
    fallback_tier: fallbackTier,
  });
}

function finalizeAdaptiveReceipt({ adaptive, receipt, hasValidSummary, winningPair, route }) {
  if (!receipt) {
    receipt = hasValidSummary
      ? createOrdinaryAdaptiveReceipt(
        adaptive,
        winningPair,
        route ? ADAPTIVE_FALLBACK_REASONS.SELECTION_REJECTED : ADAPTIVE_FALLBACK_REASONS.ROUTER_FALLBACK,
      )
      : selectAdaptive({
        // Normalize malformed object summaries so invalid_evidence never echoes live binding
        // fields next to incumbent: null.
        summary: adaptive.summary === null || adaptive.summary === undefined ? null : 'invalid',
        rank: [winningPair],
        ordinary: winningPair,
        job: adaptive.job,
        price: () => null,
      });
  }
  return deepFreezeJson(receipt);
}

module.exports = {
  ADAPTIVE_FALLBACK_REASONS,
  createOrdinaryAdaptiveReceipt,
  createSelection,
  finalizeAdaptiveReceipt,
  modelEffortPair,
  resolveAdaptiveLevel,
};
