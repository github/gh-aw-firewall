/**
 * Production wiring for private model routing in the AWF API proxy.
 *
 * Assembles the routing controller from environment configuration and the live
 * Copilot adapter, then exposes it as a session that startup.js starts once and
 * drains on shutdown.
 *
 * Session lifecycle:
 *   start()            → plan → write selection.json
 *   observation        → advisory: record requested vs. selected model per request
 *   shutdown()         → abort in-flight work, drain, then write complete.json
 *
 * The input and output directories belong to the proxy alone and are the only
 * channel back to the host, so every file there is opened with O_NOFOLLOW and
 * checked for size and link count before it is parsed.
 */

'use strict';

const privateFs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { TextDecoder } = require('util');
const exact = require('./catalogue-contract/exact-pricing');
const { resolveModelPricing } = require('./guards/ai-credits-guard');
const { normalizePolicyList } = require('./routing-candidates');
const { createRoutingCatalogue } = require('./routing-catalogue');
const { parseRoutingConfig } = require('./routing-config');
const { createRoutingController } = require('./routing-controller');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { createRoutingObservation } = require('./routing-observation');
const { writeRoutingRecord } = require('./routing-persistence');
const { createRoutingProviderExecutor } = require('./routing-provider-executor');
const { createRoutingRouterClient } = require('./routing-router-client');
const { cachedModels } = require('./key-validation');
const { logRequest } = require('./logging');
const { checkRateLimit, proxyRequest } = require('./proxy-request');
const { getRuntimeModels } = require('./runtime-model-catalog');

// Tracing is optional, as in proxy-request.js.
let defaultRouterTracing = null;
try {
  ({ routerCallTracing: defaultRouterTracing = null } = require('./otel'));
} catch (err) {
  if (!err || err.code !== 'MODULE_NOT_FOUND') throw err;
}

/**
 * Read the staged conversation the planner classifies.
 *
 * @param {string} filePath Path inside the private input directory.
 * @param {{ signal?: AbortSignal }} [options]
 * @returns {Promise<unknown>} Parsed conversation.
 * @throws {RoutingError} Always a routing error, so parse details never surface.
 */
async function loadRoutingConversation(filePath, { signal } = {}) {
  if (signal?.aborted) {
    throw createRoutingError('routing_cancelled', 'Model routing was cancelled');
  }
  try {
    return readPrivateRoutingJson(filePath, 1_048_576);
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError || error instanceof RoutingError) {
      throw createRoutingError('routing_contract_error', 'The private routing conversation is invalid');
    }
    throw createRoutingError('routing_configuration_error', 'The private routing conversation is unavailable');
  }
}

const STAGED_ADAPTIVE_BYTES = 64 * 1024;
// Never estimate a pair's cost from a price that is not the model's own tariff.
const NOT_A_TARIFF = new Set(['dynamic_selector_fallback', 'configured_default', 'median_estimate', 'builtin_fallback']);

/**
 * The job AWF itself runs in, which the evidence summary must name: gh-aw's workflow ID (the
 * lock file name without `.lock.yml`), the run ID and the attempt.
 */
function adaptiveJob(env = process.env) {
  const file = (env.GITHUB_WORKFLOW_REF || '').trim().split('@')[0].split('/').pop() || '';
  return Object.freeze({
    workflow: file.endsWith('.lock.yml') ? file.slice(0, -'.lock.yml'.length) : file.replace(/\.ya?ml$/, ''),
    run_id: (env.GITHUB_RUN_ID || '').trim(),
    attempt: Number.parseInt((env.GITHUB_RUN_ATTEMPT || '1').trim(), 10),
  });
}

/**
 * Read the evidence summary the host staged from `apiProxy.routing.adaptiveSummaryFile`: an
 * envelope saying whether the host found the file, and the parsed summary if so. Anything the
 * host could not stage is invalid evidence, so the run routes ordinarily with that reason.
 */
function loadAdaptiveInput(filePath, env = process.env) {
  const job = adaptiveJob(env);
  let staged;
  try {
    staged = readPrivateRoutingJson(filePath, STAGED_ADAPTIVE_BYTES);
  } catch {
    return Object.freeze({ job, summary: 'invalid' });
  }
  if (staged?.status === 'missing') return Object.freeze({ job, summary: null });
  // A present file that holds JSON null is invalid evidence; null alone means no file.
  if (staged?.status === 'present' && staged.summary !== undefined && staged.summary !== null) {
    return Object.freeze({ job, summary: staged.summary });
  }
  return Object.freeze({ job, summary: 'invalid' });
}

/**
 * Credits for a run's average tokens at a model's own base tariff, with the meter's semantics:
 * input excludes cache reads and writes, and reasoning is part of output, charged at the
 * reasoning rate when the tariff has one. Long-context tiers and promotions apply per request,
 * so a per-run estimate uses the default tier at list price. Fallback prices give no estimate.
 */
function createAdaptivePrice(resolve = resolveModelPricing) {
  return (mapping, tokens) => {
    let resolution;
    try {
      resolution = resolve(mapping.wireModel, undefined, mapping.provider, 0, { quiet: true, allowMedianEstimate: false });
    } catch {
      return null;
    }
    if (!resolution || resolution.estimate || resolution.usedFallbackPricing === true ||
        NOT_A_TARIFF.has(resolution.source)) return null;
    const { pricing } = resolution;
    // A partial tariff keeps its own source but can fill components from fallbacks.
    const ownTariff = field => !NOT_A_TARIFF.has(resolution.componentSources?.[field]?.source);
    const perToken = field => {
      if (pricing[field] === undefined || pricing[field] === null) return null;
      const value = exact.rate(pricing, field);
      return Number(value.n) / Number(value.d) / 10_000; // $ per million tokens at $0.01 per credit
    };
    const input = perToken('input');
    const output = perToken('output');
    if (input === null || output === null || !ownTariff('input') || !ownTariff('output')) return null;
    const reasoningRate = pricing.reasoning === undefined ? output : (perToken('reasoning') ?? 0);
    const reasoning = tokens.reasoning === null ? 0 : Math.min(tokens.reasoning, tokens.output);
    if ((tokens.cache_read > 0 && !ownTariff('cachedInput')) || (tokens.cache_write > 0 && !ownTariff('cacheWrite')) ||
        (reasoning > 0 && pricing.reasoning !== undefined && !ownTariff('reasoning'))) return null;
    return tokens.input * input + tokens.cache_read * (perToken('cachedInput') ?? 0) +
      tokens.cache_write * (perToken('cacheWrite') ?? 0) + (tokens.output - reasoning) * output +
      reasoning * reasoningRate;
  };
}

/**
 * Route routing stage records into the proxy log at the matching severity.
 *
 * @param {(level: string, event: string, record: object) => void} [writeLog]
 * @returns {{ record: (record: object) => void }}
 */
function createRoutingObserver(writeLog = logRequest) {
  return Object.freeze({
    record(record) {
      const level = record.stage === 'failure' ? 'warn' : 'info';
      try {
        writeLog(level, 'model_routing', record);
      } catch {
        // Console logging must not prevent persistence or affect routing.
      }
      writeRoutingRecord(record);
    },
  });
}

/**
 * Parse an allow/deny model policy supplied as a raw JSON environment value.
 *
 * @param {string|undefined} raw
 * @param {string} name Environment variable name, used in the error message.
 * @returns {string[]|null}
 */
function parsePolicyList(raw, name) {
  let value;
  try {
    value = raw === undefined ? null : JSON.parse(raw);
  } catch {
    throw createRoutingError('routing_configuration_error', `${name} must contain valid JSON`);
  }
  return normalizePolicyList(value, name);
}

/**
 * Compose a routing controller from environment configuration.
 *
 * Returns null when routing is not configured. The controller is dormant: it
 * contacts no router until run() is called.
 *
 * @returns {{ run: Function }|null}
 */
function createProductionRoutingController({
  rawConfig = process.env.AWF_ROUTING_CONFIG,
  getAdapter,
  getCopilotAdapter,
  routerTransport,
  routerTracing = defaultRouterTracing,
  observer = createRoutingObserver(),
  clock,
  random,
  eligibilityStore,
  eligibilityScope,
} = {}) {
  const config = parseRoutingConfig(rawConfig);
  if (config === null) return null;
  const policy = {
    allowedModels: parsePolicyList(process.env.AWF_ALLOWED_MODELS, 'AWF_ALLOWED_MODELS'),
    disallowedModels: parsePolicyList(process.env.AWF_DISALLOWED_MODELS, 'AWF_DISALLOWED_MODELS'),
  };
  if (typeof getAdapter !== 'function' && typeof getCopilotAdapter !== 'function') {
    throw createRoutingError('routing_configuration_error', 'The provider adapter owner is unavailable');
  }
  const resolveAdapter = getAdapter || (provider => provider === 'copilot' ? getCopilotAdapter?.() : null);

  const catalogue = createRoutingCatalogue({
    getAdapter: resolveAdapter,
    getDiscoveredModels: provider => cachedModels[provider],
    getRuntimeModels,
  });
  const executor = createRoutingProviderExecutor({
    getAdapter: resolveAdapter,
    proxyRequest,
    checkRateLimit,
  });

  const adaptive = config.adaptiveSummaryFile ? loadAdaptiveInput(config.adaptiveSummaryFile) : undefined;
  return createRoutingController({
    config,
    planner: createRoutingRouterClient({ transport: routerTransport, tracing: routerTracing }),
    ...(adaptive ? { adaptive, priceRoute: createAdaptivePrice() } : {}),
    catalogue,
    policy,
    loadConversation: loadRoutingConversation,
    executor,
    observer,
    routerIdentity: Object.freeze({ name: 'gh-aw-router' }),
    ...(eligibilityStore ? { eligibilityStore } : {}),
    ...(eligibilityScope ? { eligibilityScope } : {}),
    ...(clock ? { clock } : {}),
    ...(random ? { random } : {}),
  });
}

/**
 * Read and parse a JSON file from the private routing directories.
 *
 * Validates the opened descriptor rather than the path, so the file cannot be
 * swapped for a link or grown between the check and the read.
 *
 * @param {string} filename
 * @param {number} [maxBytes]
 * @returns {unknown}
 */
function readPrivateRoutingJson(filename, maxBytes = 16_384) {
  const descriptor = privateFs.openSync(filename,
    privateFs.constants.O_RDONLY | privateFs.constants.O_NOFOLLOW | privateFs.constants.O_NONBLOCK);
  try {
    const stat = privateFs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) {
      throw createRoutingError('routing_contract_error', 'Invalid private routing file');
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = privateFs.readSync(descriptor, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > maxBytes) throw createRoutingError('routing_contract_error', 'Oversized private routing file');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)));
  } finally {
    privateFs.closeSync(descriptor);
  }
}

/**
 * Write a routing result the host will read, atomically and exactly once.
 *
 * The host treats the first result it sees as authoritative, so an existing
 * file is an error rather than something to overwrite.
 *
 * @param {string} outputDir
 * @param {string} name
 * @param {object} record
 */
function publishRoutingResult(outputDir, name, record) {
  const content = JSON.stringify(record);
  if (Buffer.byteLength(content) > 16_384) {
    throw createRoutingError('routing_contract_error', 'Routing result exceeds its byte limit');
  }
  const filename = path.join(outputDir, name);
  const temporary = path.join(outputDir, `.${randomUUID()}.tmp`);
  try {
    if (privateFs.existsSync(filename)) throw createRoutingError('routing_contract_error', 'Routing result already exists');
    privateFs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    privateFs.renameSync(temporary, filename);
  } finally {
    privateFs.rmSync(temporary, { force: true });
  }
}

/**
 * Build the routing session the proxy owns for the lifetime of the run.
 *
 * Returns null when routing is not configured. The returned object also spreads
 * the observation surface (observeRequest, drain) so callers hold a single
 * routing handle.
 *
 * @returns {object|null}
 */
function createProductionRoutingSession({
  rawConfig = process.env.AWF_ROUTING_CONFIG,
  getAdapter,
  getCopilotAdapter,
  outputDir = '/run/awf-routing/output',
  createController = createProductionRoutingController,
  observer = createRoutingObserver(),
  fatalExit = code => process.exit(code),
} = {}) {
  if (rawConfig === undefined) return null;
  const abortController = new AbortController();
  const deadline = Date.now() + 90_000;
  let runPromise;
  let result;
  let terminalFailure;
  let pendingFailure;
  let drained = false;

  // A request failure is provisional until all responses (including decoded
  // SSE inspection) drain. Only a later completed selected-model request can
  // recover it; cancellation is neither failure nor recovery evidence.
  function recordFailure(code) {
    pendingFailure = toRoutingFailure(createRoutingError(code, 'Routed execution failed'));
  }

  function publishRuntimeFailure() {
    if (!pendingFailure || terminalFailure || !result?.ok) return;
    terminalFailure = pendingFailure;
    try {
      observer.record({ stage: 'failure', phase: 'primary', code: terminalFailure.code });
    } catch {
      // Observability must not change the routing decision or the live response.
    }
    try {
      publishRoutingResult(outputDir, 'runtime-failure.json', terminalFailure);
    } catch {
      // Unpublishable: exit 78 (routing-failure) rather than leave the host
      // waiting on a claim nobody verified.
      fatalExit(78);
    }
  }

  const getSelection = () => result?.ok ? result.selection : null;
  const getFailure = () => terminalFailure || (result && !result.ok ? result.failure : null);

  // Agent-visible view of the selection. Advisory: the agent/harness seeds its
  // model, effort, and endpoint from it, but may send any policy-permitted model.
  function getReflectState() {
    const failure = getFailure();
    if (failure) return { status: 'failed', failure_code: failure.code, selection: null };
    const selection = getSelection();
    if (!selection) return { status: 'pending', selection: null };
    const provider = selection.provider || 'copilot';
    const effort = Object.hasOwn(selection.choice, 'effort') ? selection.choice.effort : null;
    return {
      status: 'selected',
      selection: {
        provider,
        model: selection.choice.model,
        wire_model: selection.wire_model,
        effort,
        endpoint: selection.endpoint || (provider === 'anthropic' ? '/v1/messages' : (effort === null ? '/chat/completions' : '/responses')),
      },
    };
  }
  const observation = createRoutingObservation({
    getSelection, recordFailure, recordSuccess: () => { pendingFailure = null; }, observer,
  });

  async function execute() {
    try {
      for (const name of ['selection.json', 'failure.json', 'runtime-failure.json', 'complete.json']) {
        if (privateFs.existsSync(path.join(outputDir, name))) {
          throw createRoutingError('routing_contract_error', 'Stale routing results cannot be reused');
        }
      }
      const controller = createController({ rawConfig, getAdapter, getCopilotAdapter, observer });
      result = await controller.run({ signal: abortController.signal, jobDeadlineMs: deadline });
      if (result.ok) {
        // The bounded options are host-only; do not attach them to the live selection.
        publishRoutingResult(outputDir, 'selection.json', result.routeOptions
          ? { ...result.selection, routeOptions: result.routeOptions } : result.selection);
      } else {
        publishRoutingResult(outputDir, 'failure.json', result.failure);
      }
    } catch (error) {
      result = Object.freeze({ ok: false, failure: toRoutingFailure(error instanceof RoutingError ? error :
        createRoutingError('routing_configuration_error', 'Private routing bootstrap failed')) });
      try {
        if (!privateFs.existsSync(path.join(outputDir, 'selection.json')) &&
            !privateFs.existsSync(path.join(outputDir, 'failure.json'))) {
          publishRoutingResult(outputDir, 'failure.json', result.failure);
        }
      } catch {
        // Unpublishable: exit 78 (routing-failure) rather than leave the host
        // waiting on a claim nobody verified.
        fatalExit(78);
      }
    }
    return result;
  }

  return Object.freeze({
    start() {
      if (!runPromise) runPromise = execute();
      return runPromise;
    },
    async shutdown() {
      abortController.abort();
      await runPromise;
      await observation.drain();
      publishRuntimeFailure();
      drained = true;
    },
    completeShutdown() {
      if (!drained) throw createRoutingError('routing_contract_error', 'Routing shutdown is incomplete');
      if (result?.ok) publishRoutingResult(outputDir, 'complete.json', { schema: 'awf-routing-complete/v1' });
    },
    getSelection,
    getFailure,
    getReflectState,
    ...observation,
  });
}

module.exports = {
  adaptiveJob,
  createAdaptivePrice,
  loadAdaptiveInput,
  createProductionRoutingController,
  createRoutingObserver,
  loadRoutingConversation,
  createProductionRoutingSession,
  readPrivateRoutingJson,
};
