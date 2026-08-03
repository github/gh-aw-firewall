'use strict';

/**
 * Parses an AWF-generated private-repository seed map.
 *
 * The caller supplies the trusted sensitivity policy; request data can never
 * choose a path, seed id, sensitivity, or run identity through this helper.
 */
function parsePrivateRepositorySeedMap(serialized, sensitivityRunBits) {
  const parsed = JSON.parse(serialized);
  if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.seeds)) {
    throw new Error('Seed map is malformed or is an unsupported version');
  }
  if (typeof parsed.runId !== 'string' || !/^[0-9a-f]{8,}$/.test(parsed.runId)) {
    throw new Error('Seed map has no usable runId');
  }

  const seeds = new Map();
  for (const entry of parsed.seeds) {
    if (
      !entry
      || typeof entry.repo !== 'string'
      || typeof entry.seedId !== 'string'
      || !Object.prototype.hasOwnProperty.call(sensitivityRunBits, entry.sensitivity)
    ) {
      throw new Error('Seed map entry is malformed');
    }
    if (!/^[0-9a-f]{16,64}$/.test(entry.seedId)) {
      throw new Error('Seed map entry has an unexpected seed id');
    }
    seeds.set(entry.repo.toLowerCase(), { seedId: entry.seedId, sensitivity: entry.sensitivity });
  }

  return { runId: parsed.runId, seeds };
}

module.exports = { parsePrivateRepositorySeedMap };
