'use strict';

const {
  informationChargeForSchema,
  schemaContainsFreeformString,
} = require('../../bounded-execution/finite-disclosure');

function createExecutorInvocationAdmission({
  config, seedMap, runner, ledger, executorKind, validateRequest, payloadKey,
  admission, markAdmitted, settleDynamic,
}) {
  return async function admitInvocation(request, invocationId, rejectBeforeExecution) {
    const validation = validateRequest(request);
    if (!validation.valid) {
      await rejectBeforeExecution('invalid-request', validation.errors.join('; '));
      return;
    }
    const { privateRepo, schema } = validation.request;
    const payload = validation.request[payloadKey];
    const repoKey = privateRepo.toLowerCase();

    let seed;
    let admitted;
    if (admission) {
      // Canonical admission runs *before* any repository content is exposed:
      // no workspace, no container, and no delegated bearer exists until AWF
      // has matched the selector against the compiler envelope, reserved
      // every run-wide quota, and minted exactly one identity.
      admitted = await admission.admit({ invocationId, selector: privateRepo, schema });
      if (!admitted || !admitted.admitted) {
        await rejectBeforeExecution('dynamic-admission-denied', undefined);
        return;
      }
      markAdmitted(invocationId);
      // Register into the *same* live per-repository ledger the static
      // executors debit. Registration is idempotent, so re-admitting a
      // repository can never refill a budget it has already spent.
      try {
        ledger.registerRepository(admitted.repo, admitted.sensitivity);
      } catch (error) {
        await settleDynamic(invocationId, 'broker-error', 0, 0);
        await rejectBeforeExecution('dynamic-sensitivity-invalid', error.message);
        return;
      }
      seed = { seedId: undefined, sensitivity: admitted.sensitivity };
    } else if (runner.hostOwned && config.dynamicEnabled) {
      // The host alone admits the selector and owns its delegated identity.
      // Reserve the worst-case disclosure locally before asking it to launch;
      // denied selectors never refund or reset the shared repository ledger.
      ledger.registerRepository(repoKey, config.dynamicSensitivity);
      seed = { seedId: undefined, sensitivity: config.dynamicSensitivity };
    } else {
      seed = seedMap.get(repoKey);
      if (!seed) {
        await rejectBeforeExecution('repo-not-allowed', privateRepo);
        return;
      }
    }
    if (schemaContainsFreeformString(schema) && seed.sensitivity !== 'trusted') {
      if (admitted) await settleDynamic(invocationId, 'schema-failure', 0, 0);
      await rejectBeforeExecution(
        'trusted-schema-required',
        `repo=${privateRepo} sensitivity=${seed.sensitivity}`,
      );
      return;
    }

    // Compute and debit the charge for THIS invocation's schema *before*
    // copying a seed or launching Python. Every invocation may declare a
    // different schema; there is no separate per-query cap — only whether
    // this charge fits the repository's remaining run balance.
    const charge = seed.sensitivity === 'trusted' ? 0 : informationChargeForSchema(schema);
    if (!ledger.tryDebit(admitted ? admitted.repo : repoKey, charge, executorKind)) {
      if (admitted) await settleDynamic(invocationId, 'broker-error', 0, 0);
      await rejectBeforeExecution('bit-budget-exhausted', `repo=${privateRepo} charge=${charge}`);
      return;
    }

    return { privateRepo, repoKey, schema, payload, seed, admitted, charge };
  };
}

module.exports = { createExecutorInvocationAdmission };
