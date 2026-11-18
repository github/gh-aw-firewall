/**
 * Filter model catalogues and aliases to configured, resolvable providers.
 */

const { resolveAliasDefinition } = require('./model-alias-config');

/**
 * Filter an alias map to only include aliases resolvable to at least one
 * available model for at least one provider that has model data.
 *
 * An alias is kept when:
 *   - No provider has model data yet and its patterns can target a configured
 *     provider (or configured providers are unknown).
 *   - The alias resolves to a concrete model for at least one provider with data.
 *
 * Middle-power fallback is intentionally disabled during filtering so that only
 * genuine alias→model matches are counted; fallback selections would keep aliases
 * alive even after all their target models have been retired.
 *
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Record<string, string[]|null>} availableModels - Cached models per provider (null = not yet fetched)
 * @param {Set<string>|string[]|null|undefined} configuredProviders - Provider cache keys that are configured
 * @param {Function} resolveModel - Injected to keep filtering independent of the resolution module
 * @returns {Record<string, string[]|{patterns: string[], fallback?: boolean}>}
 */
function filterResolvableAliases(aliases, availableModels, configuredProviders, resolveModel) {
  if (!aliases || typeof aliases !== 'object') return aliases;
  const configured = configuredProviders === null || configuredProviders === undefined
    ? null
    : (configuredProviders instanceof Set
      ? configuredProviders
      : new Set(Array.isArray(configuredProviders) ? configuredProviders : []));

  // Providers with a non-empty model list (data is available)
  const providersWithData = Object.entries(availableModels)
    .filter(([, models]) => Array.isArray(models) && models.length > 0)
    .map(([provider]) => provider);

  if (providersWithData.length === 0) {
    if (configured === null) return aliases;
    const result = {};
    for (const aliasKey of Object.keys(aliases)) {
      if (_aliasCanTargetConfiguredProvider(aliasKey, aliases, configured)) {
        result[aliasKey] = aliases[aliasKey];
      }
    }
    return result;
  }

  const noFallback = { enabled: false };
  const result = {};
  const configuredProvidersWithoutData = configured === null
    ? new Set()
    : new Set([...configured].filter(provider => !Array.isArray(availableModels[provider])));

  for (const aliasKey of Object.keys(aliases)) {
    const canResolveWithKnownModels = providersWithData.some(provider => {
      const resolution = resolveModel(aliasKey, aliases, availableModels, provider, [], noFallback, null, false);
      return resolution !== null;
    });
    const mayResolveWhenPendingCatalogLoads = _aliasCanTargetConfiguredProvider(
      aliasKey,
      aliases,
      configuredProvidersWithoutData,
    );

    if (canResolveWithKnownModels || mayResolveWhenPendingCatalogLoads) {
      result[aliasKey] = aliases[aliasKey];
    }
  }

  return result;
}

/**
 * Conservatively determine whether an alias can target any configured provider
 * before provider model catalogues are available.
 *
 * @param {string} aliasKey
 * @param {Record<string, string[]|{patterns: string[], fallback?: boolean}>} aliases
 * @param {Set<string>} configuredProviders
 * @param {Set<string>} [chain]
 * @returns {boolean}
 */
function _aliasCanTargetConfiguredProvider(aliasKey, aliases, configuredProviders, chain = new Set()) {
  const normalizedKey = aliasKey.toLowerCase();
  if (chain.has(normalizedKey)) return false;

  const aliasEntry = Object.entries(aliases).find(([key]) => key.toLowerCase() === normalizedKey);
  if (!aliasEntry) return configuredProviders.size > 0;

  const nextChain = new Set(chain);
  nextChain.add(normalizedKey);
  const { patterns } = resolveAliasDefinition(aliasEntry[1]);
  return patterns.some((pattern) => {
    const slashIdx = pattern.indexOf('/');
    if (slashIdx !== -1) {
      return configuredProviders.has(pattern.slice(0, slashIdx).toLowerCase());
    }
    return _aliasCanTargetConfiguredProvider(pattern, aliases, configuredProviders, nextChain);
  });
}

/**
 * Restrict a provider→models map to the providers that are actually configured
 * for this run.
 *
 * Alias resolution treats any provider with a populated model list as a valid
 * steering target. When a provider slot has no credentials (the proxy reports
 * `configured: false` for it and answers every request with
 * `provider_not_configured`), steering a request there guarantees a 100% failure
 * rate. Blanking those providers' model lists before resolution makes them
 * invisible to the alias table, so candidates are only ever drawn from provider
 * slots that can actually serve a request.
 *
 * When `configuredProviders` is null/undefined, the map is returned unchanged
 * because configuration is unknown. An empty set is a known state and blanks
 * every provider.
 *
 * @param {Record<string, string[]|null>} availableModels
 * @param {Set<string>|string[]|null|undefined} configuredProviders - Provider cache keys that are configured
 * @returns {Record<string, string[]|null>}
 */
function filterAvailableModelsToConfiguredProviders(availableModels, configuredProviders) {
  if (!availableModels || typeof availableModels !== 'object') return availableModels;
  if (configuredProviders === null || configuredProviders === undefined) return availableModels;

  const configured = configuredProviders instanceof Set
    ? configuredProviders
    : new Set(Array.isArray(configuredProviders) ? configuredProviders : []);

  const result = {};
  for (const [provider, models] of Object.entries(availableModels)) {
    result[provider] = configured.has(provider) ? models : null;
  }
  return result;
}

module.exports = {
  filterResolvableAliases,
  filterAvailableModelsToConfiguredProviders,
};
