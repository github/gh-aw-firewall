/**
 * CI guard: verifies that SUPPORTED_COPILOT_MODELS and the api-proxy pricing
 * catalog stay in sync.
 *
 * When a new Copilot CLI completion model is added to
 * containers/api-proxy/ai-credits-pricing.js, it must ALSO appear in
 * SUPPORTED_COPILOT_MODELS in src/copilot-model.ts.  Without that, AWF rejects
 * the COPILOT_MODEL value with a misleading "retired or unsupported" error
 * before containers even start (as happened with mai-code-1-flash in #5831).
 *
 * When adding a new entry to ai-credits-pricing.js, you must either:
 *   (a) Add the model to SUPPORTED_COPILOT_MODELS in src/copilot-model.ts, OR
 *   (b) Add it to INTENTIONALLY_EXCLUDED_FROM_SUPPORTED below with a comment
 *       explaining why it is not a Copilot CLI completion model.
 */

import * as path from 'path';
import * as fs from 'fs';
import { testHelpers } from './copilot-model';

/** Mirrors the full canonicalization in copilot-model.ts: lowercase then replace separators. */
function normalizeSeparators(s: string): string {
  return s.replace(/[._]/g, '-').toLowerCase();
}

/**
 * Models present in ai-credits-pricing.js that are intentionally absent from
 * SUPPORTED_COPILOT_MODELS.  These are either non-completion models (e.g.
 * embeddings), BYOK/OpenRouter-only models, or older versioned variants that
 * the Copilot CLI model picker does not surface.
 *
 * Add an entry here (with a comment) only when the model truly should NOT be
 * settable via COPILOT_MODEL.
 */
const INTENTIONALLY_EXCLUDED_FROM_SUPPORTED = new Set([
  // ── Embedding models — cannot be used as COPILOT_MODEL ────────────────────
  'text-embedding-3-small', // text embedding, not a chat/completion model
  'text-embedding-ada-002', // text embedding, not a chat/completion model

  // ── Older Claude Opus 4 versions ──────────────────────────────────────────
  // Only the latest revision (claude-opus-4.8) is exposed in the Copilot CLI
  // model picker; older versioned slugs are priced for BYOK/billing purposes.
  'claude-opus-4-5',
  'claude-opus-4-6',
  'claude-opus-4-7',

  // ── Unversioned Claude Sonnet 4 base alias ────────────────────────────────
  // Use explicit versioned models (claude-sonnet-4.5, claude-sonnet-4.6) instead.
  'claude-sonnet-4',

  // ── Gemini models not yet available via the Copilot CLI model picker ──────
  'gemini-2.5-pro',  // older generation
  'gemini-3-flash',  // not surfaced in Copilot CLI
  'gemini-3.1-flash', // not surfaced in Copilot CLI (different from gemini-3.1-pro-preview)
  'gemini-3.1-pro',  // not surfaced in Copilot CLI (different from gemini-3.1-pro-preview)

  // ── GPT variants not in the Copilot CLI model picker ─────────────────────
  'gpt-5-codex-mini', // internal variant; not a public Copilot CLI model
  'gpt-5.4-nano',     // not yet surfaced in Copilot CLI

  // ── Internal / experimental models ───────────────────────────────────────
  'raptor-mini', // internal model; not a public Copilot CLI model
]);

const SUPPORTED_WITHOUT_CURATED_PRICING = new Set([
  'gpt-4',
  'gpt-4-1',
  'gpt-4-5',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-5-1',
  'o3',
  'o3-mini',
  'gemini-3-1-pro-preview',
]);

const MAPPING_FAMILIES_NOT_EXPOSED_BY_COPILOT_CLI = new Set([
  'gpt-5-1-codex-max',
  'gpt-5-codex/pro',
  'o4-mini-deep-research',
  'o4',
  'o3-pro/deep-research',
  'o1-pro',
  'o1',
  'computer-use-preview',
  'codex-mini',
  'chatgpt-4o-latest',
  'gpt-4-turbo',
  'gpt-3-5-turbo',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-7-sonnet',
  'claude-3-opus',
]);

describe('SUPPORTED_COPILOT_MODELS ↔ ai-credits-pricing catalog sync', () => {
  const pricingPath = path.resolve(
    __dirname,
    '..',
    'containers',
    'api-proxy',
    'ai-credits-pricing.js',
  );

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pricing = require(pricingPath) as Record<string, unknown>;
  const pricingModels = Object.keys(pricing);

  it('every Copilot CLI model in ai-credits-pricing.js appears in SUPPORTED_COPILOT_MODELS', () => {
    // Build a separator-normalised view of the supported set so that
    // claude-haiku-4-5 (pricing) matches claude-haiku-4.5 (SUPPORTED).
    const normalizedSupported = new Set(
      [...testHelpers.supportedCopilotModels].map(m => normalizeSeparators(m)),
    );

    const missing: string[] = [];
    for (const model of pricingModels) {
      if (INTENTIONALLY_EXCLUDED_FROM_SUPPORTED.has(model)) continue;
      if (!normalizedSupported.has(normalizeSeparators(model))) {
        missing.push(model);
      }
    }

    if (missing.length > 0) {
      const modelList = missing.map(m => `  '${m}'`).join('\n');
      throw new Error(
        `Found ${missing.length} model(s) in containers/api-proxy/ai-credits-pricing.js ` +
          `that are missing from SUPPORTED_COPILOT_MODELS in src/copilot-model.ts:\n` +
          `${modelList}\n\n` +
          `If this is a new Copilot CLI completion model, add it to SUPPORTED_COPILOT_MODELS.\n` +
          `If it is NOT a Copilot CLI model, add it to INTENTIONALLY_EXCLUDED_FROM_SUPPORTED ` +
          `in src/copilot-model-catalog-sync.test.ts with a comment explaining why.`,
      );
    }
  });

  it('every supported model has curated pricing or an explicit static-catalog fallback', () => {
    const normalizedPricing = new Set(pricingModels.map(normalizeSeparators));
    const missing = [...testHelpers.supportedCopilotModels]
      .map(normalizeSeparators)
      .filter(model => model !== 'auto')
      .filter(model => !SUPPORTED_WITHOUT_CURATED_PRICING.has(model))
      .filter(model => !normalizedPricing.has(model));
    expect(missing).toEqual([]);
  });

  it('every mapped completion family is represented or explicitly excluded', () => {
    const mappingPath = path.resolve(__dirname, '..', 'docs', 'model-api-mapping.json');
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')) as {
      providers: Record<string, { models?: Array<{ family?: string }> }>;
    };
    const normalizedSupported = [...testHelpers.supportedCopilotModels].map(normalizeSeparators);
    const missing: string[] = [];
    for (const provider of Object.values(mapping.providers)) {
      for (const entry of provider.models || []) {
        if (!entry.family) continue;
        const family = normalizeSeparators(entry.family);
        if (MAPPING_FAMILIES_NOT_EXPOSED_BY_COPILOT_CLI.has(family)) continue;
        if (!normalizedSupported.some(model => model === family || model.startsWith(`${family}-`))) {
          missing.push(entry.family);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
