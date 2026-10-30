#!/usr/bin/env node
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const configPaths = process.argv.slice(2);
if (configPaths.length !== 2) throw new Error('Usage: configure-aoai-smoke-pricing.cjs <runner-config> <sandbox-config>');
const source = fs.readFileSync(path.resolve(__dirname, '../../containers/api-proxy/models.dev.catalog.json'), 'utf8');
// The repository operator confirmed these standard Azure deployment rates and model mapping.
// Keep them scoped to these smoke configurations; imported batch pricing is discounted.
const pricing = { input: 1.1, cachedInput: 0.275, output: 4.4 };
const catalog = {
  schemaVersion: 1,
  unit: 'USD_PER_1M_TOKENS',
  catalogId: 'github/gh-aw-firewall/azure-byok-smoke',
  version: `sha256:${createHash('sha256').update(source).digest('hex')}`,
  providers: {
    copilot: {
      models: {
        'o4-mini-aw': {
          input: pricing.input,
          cachedInput: pricing.cachedInput,
          cacheWrite: null,
          output: pricing.output,
          reasoning: pricing.output,
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
