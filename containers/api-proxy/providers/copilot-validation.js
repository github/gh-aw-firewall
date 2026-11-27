'use strict';

const { getTargetScheme, stripTargetScheme } = require('../proxy-utils');
const { isGithubCopilotCatalogTarget } = require('./copilot-auth');
const { tokenAuthHeaders, withCopilotIntegration } = require('./auth-headers');

const COPILOT_MODELS_API_VERSION = '2026-07-01';

/**
 * Build a standard Copilot `/models` GET request using the GitHub OAuth token.
 * Validation and model discovery must use the same auth headers for this endpoint.
 *
 * @param {object} context
 * @param {Record<string, unknown>} [extra] - Additional top-level properties
 *   (e.g. `{ cacheKey: 'copilot' }`).
 */
function buildCopilotModelsRequest({ rawTarget, githubTokenAuthPrefix, githubToken, integrationId }, extra = {}) {
  return {
    url: `${getTargetScheme(rawTarget)}://${stripTargetScheme(rawTarget)}/models`,
    opts: {
      method: 'GET',
      headers: withCopilotIntegration(
        tokenAuthHeaders(githubTokenAuthPrefix, githubToken, { 'X-GitHub-Api-Version': COPILOT_MODELS_API_VERSION }),
        integrationId
      ),
    },
    modelMetadataFormat: 'copilot',
    apiVersion: COPILOT_MODELS_API_VERSION,
    ...extra,
  };
}

function getCopilotValidationProbe(context) {
  const { oidcConfigured, authProvider, databricksSelected, authToken, githubToken, rawTarget } = context;
  if (oidcConfigured) {
    return { skip: true, reason: `OIDC auth (${authProvider}); validation via token acquisition` };
  }
  if (databricksSelected) return null;
  if (!authToken) return null;

  // Only COPILOT_GITHUB_TOKEN has a probe endpoint (/models).
  // COPILOT_PROVIDER_API_KEY alone cannot be validated at startup.
  if (!githubToken) {
    return {
      skip: true,
      reason: 'COPILOT_PROVIDER_API_KEY configured but startup validation is not supported for this auth mode',
    };
  }

  if (!isGithubCopilotCatalogTarget(rawTarget)) {
    return { skip: true, reason: `Custom target ${rawTarget}; validation skipped` };
  }

  return buildCopilotModelsRequest(context);
}

module.exports = {
  COPILOT_MODELS_API_VERSION,
  buildCopilotModelsRequest,
  getCopilotValidationProbe,
};
