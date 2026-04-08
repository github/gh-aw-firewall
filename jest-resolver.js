/**
 * Custom Jest resolver that handles ESM-only packages.
 *
 * Some packages (e.g., unicorn-magic, is-unicode-supported) only provide
 * "import" conditions in their package.json exports maps. When babel-jest
 * transforms ESM to CJS, the resulting require() calls fail because Jest's
 * default resolver only checks "require" and "node" conditions.
 *
 * This resolver falls back to the "import" condition when the default
 * resolution fails for exports-related reasons, allowing these packages
 * to be resolved correctly while still surfacing unrelated errors.
 */
const isExportsResolutionError = (error) => {
  if (!error) {
    return false;
  }

  if (error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message : '';
  return (
    message.includes('Package subpath') ||
    message.includes('package exports') ||
    message.includes('conditional exports') ||
    message.includes('No "exports" main defined')
  );
};

module.exports = (path, options) => {
  try {
    return options.defaultResolver(path, options);
  } catch (error) {
    if (!isExportsResolutionError(error)) {
      throw error;
    }

    try {
      return options.defaultResolver(path, {
        ...options,
        conditions: [...(options.conditions || []), 'import'],
      });
    } catch (_fallbackError) {
      throw error;
    }
  }
};
