#!/usr/bin/env node
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const configPaths = process.argv.slice(2);
if (configPaths.length !== 2) throw new Error('Usage: configure-aoai-smoke-pricing.cjs <runner-config> <sandbox-config>');
const source = fs.readFileSync(path.resolve(__dirname, '../../containers/api-proxy/models.dev.catalog.json'), 'utf8');
const model = JSON.parse(source).data.find(entry => entry.id === 'openai/o4-mini');
if (!model) throw new Error('Pinned pricing catalog is missing canonical openai/o4-mini');
function rate(category) {
  const value = model.pricing[category];
  const number = typeof value === 'string' && value.trim() ? Number(value) * 1e6 : NaN;
  if (!Number.isFinite(number) || number < 0) throw new Error(`Invalid pinned o4-mini ${category} pricing`);
  return number;
}
// The repository operator confirmed this exact Azure deployment-to-model map.
// Keep it scoped to these smoke configurations, never global model inference.
const catalog = {
  schemaVersion: 1,
  unit: 'USD_PER_1M_TOKENS',
  catalogId: 'github/gh-aw-firewall/azure-byok-smoke',
  version: `sha256:${createHash('sha256').update(source).digest('hex')}`,
  providers: {
    copilot: {
      models: {
        'o4-mini-aw': {
          input: rate('prompt'),
          cachedInput: rate('input_cache_read'),
          cacheWrite: null,
          output: rate('completion'),
          reasoning: rate('completion'),
        },
      },
    },
  },
};
const configs = configPaths.map(file => {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!config.apiProxy?.enabled) throw new Error(`Azure smoke requires an enabled API proxy: ${file}`);
  if (config.apiProxy.modelPricingCatalog &&
      JSON.stringify(config.apiProxy.modelPricingCatalog) !== JSON.stringify(catalog)) {
    throw new Error(`Refusing to replace an existing workflow pricing catalog: ${file}`);
  }
  return config;
});
for (let index = 0; index < configPaths.length; index++) {
  configs[index].apiProxy.modelPricingCatalog = catalog;
  fs.writeFileSync(configPaths[index], JSON.stringify(configs[index]) + '\n');
}
console.log('Configured exact Azure smoke deployment pricing from the pinned o4-mini catalog; budget limits unchanged');
