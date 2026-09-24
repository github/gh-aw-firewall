/**
 * Production wiring for private model routing in the AWF API proxy.
 *
 * Assembles the routing controller from environment configuration and the live
 * Copilot adapter, then exposes it as a session that startup.js starts once and
 * drains on shutdown.
 *
 * Session lifecycle:
 *   start()            → plan → write selection.json
 *   enforcement        → admit only the selected model for the agent's request
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
const { normalizePolicyList } = require('./routing-candidates');
const { createRoutingCatalogue } = require('./routing-catalogue');
const { parseRoutingConfig } = require('./routing-config');
const { createRoutingController } = require('./routing-controller');
const { createRoutingError, RoutingError, toRoutingFailure } = require('./routing-errors');
const { createRoutingEnforcement } = require('./routing-enforcement');
const { createRoutingProviderExecutor } = require('./routing-provider-executor');
const { createRoutingRouterClient } = require('./routing-router-client');
const { cachedModels } = require('./key-validation');
const { logRequest } = require('./logging');
const { checkRateLimit, proxyRequest } = require('./proxy-request');
const { getRuntimeModels } = require('./runtime-model-catalog');

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

/**
 * Route routing stage records into the proxy log at the matching severity.
 *
 * @param {(level: string, event: string, record: object) => void} [writeLog]
 * @returns {{ record: (record: object) => void }}
 */
function createRoutingObserver(writeLog = logRequest) {
  return Object.freeze({
    record(record) {
      const level = record.stage === 'failure' || (record.stage === 'decision' && record.decision === 'reject')
        ? 'warn' : 'info';
      writeLog(level, 'model_routing', record);
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
  getCopilotAdapter,
  routerTransport,
  observer = createRoutingObserver(),
  clock,
  random,
} = {}) {
  const config = parseRoutingConfig(rawConfig);
  if (config === null) return null;
  const policy = {
    allowedModels: parsePolicyList(process.env.AWF_ALLOWED_MODELS, 'AWF_ALLOWED_MODELS'),
    disallowedModels: parsePolicyList(process.env.AWF_DISALLOWED_MODELS, 'AWF_DISALLOWED_MODELS'),
  };
  if (typeof getCopilotAdapter !== 'function') {
    throw createRoutingError('routing_configuration_error', 'The Copilot provider adapter owner is unavailable');
  }

  const catalogue = createRoutingCatalogue({
    getCopilotAdapter,
    getDiscoveredModels: provider => cachedModels[provider],
    getRuntimeModels,
  });
  const executor = createRoutingProviderExecutor({
    getCopilotAdapter,
    proxyRequest,
    checkRateLimit,
  });

  return createRoutingController({
    config,
    planner: createRoutingRouterClient({ transport: routerTransport }),
    catalogue,
    policy,
    loadConversation: loadRoutingConversation,
    executor,
    observer,
    routerIdentity: Object.freeze({ name: 'gh-aw-router' }),
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
 * the enforcement surface (screenRequest, rejectUpgrade, drain) so callers hold
 * a single routing handle.
 *
 * @returns {object|null}
 */
function createProductionRoutingSession({
  rawConfig = process.env.AWF_ROUTING_CONFIG,
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
  let drained = false;

  // Terminal failure reported from anywhere in the run. Called from the live
  // agent response path, so it must never throw back into that stream.
  function recordFailure(code) {
    if (terminalFailure || (result && !result.ok)) return;
    terminalFailure = toRoutingFailure(createRoutingError(code, 'Routed execution was rejected'));
    try {
      observer.record({ stage: 'failure', phase: result?.ok ? 'primary' : 'bootstrap', code: terminalFailure.code });
    } catch {
      // Observability must not change the routing decision or the live response.
    }
    if (!result?.ok) {
      abortController.abort();
      return;
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
  const enforcement = createRoutingEnforcement({ getSelection, getFailure, recordFailure, observer });

  async function execute() {
    try {
      for (const name of ['selection.json', 'failure.json', 'runtime-failure.json', 'complete.json']) {
        if (privateFs.existsSync(path.join(outputDir, name))) {
          throw createRoutingError('routing_contract_error', 'Stale routing results cannot be reused');
        }
      }
      const controller = createController({ rawConfig, getCopilotAdapter, observer });
      result = await controller.run({ signal: abortController.signal, jobDeadlineMs: deadline });
      if (terminalFailure) result = Object.freeze({ ok: false, failure: terminalFailure });
      publishRoutingResult(outputDir, result.ok ? 'selection.json' : 'failure.json',
        result.ok ? result.selection : result.failure);
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
      await enforcement.drain();
      drained = true;
    },
    completeShutdown() {
      if (!drained) throw createRoutingError('routing_contract_error', 'Routing shutdown is incomplete');
      if (result?.ok) publishRoutingResult(outputDir, 'complete.json', { schema: 'awf-routing-complete/v1' });
    },
    getSelection,
    getFailure,
    ...enforcement,
  });
}

module.exports = {
  createProductionRoutingController,
  createRoutingObserver,
  loadRoutingConversation,
  createProductionRoutingSession,
  readPrivateRoutingJson,
};
