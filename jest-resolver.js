/**
 * Custom Jest resolver that handles ESM-only packages.
 *
 * Some packages (e.g., unicorn-magic, is-unicode-supported) only provide
 * "import" conditions in their package.json exports maps. When babel-jest
 * transforms ESM to CJS, the resulting require() calls fail because Jest's
 * default resolver only checks "require" and "node" conditions.
 *
 * This resolver falls back to the "import" condition when the default
 * resolution fails, allowing these packages to be resolved correctly.
 */
module.exports = (path, options) => {
  try {
    return options.defaultResolver(path, options);
  } catch (error) {
    // If default resolution fails, retry with "import" condition added
    return options.defaultResolver(path, {
      ...options,
      conditions: [...(options.conditions || []), 'import'],
    });
  }
};
