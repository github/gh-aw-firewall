#!/usr/bin/env node

/**
 * Build a single-file esbuild bundle of the AWF CLI.
 *
 * This produces release/awf-bundle.js (~2 MB) which requires only a
 * system Node.js >= 20 to run — no node_modules needed.
 *
 * The seccomp profile JSON is inlined via esbuild `define` so the
 * bundle works without access to the containers/ directory tree.
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// Read the seccomp profile so we can inline it as a string constant.
// Validate that it is well-formed JSON at build time to fail fast on typos.
const seccompPath = join(projectRoot, 'containers', 'agent', 'seccomp-profile.json');
const seccompContent = readFileSync(seccompPath, 'utf-8');
try {
  JSON.parse(seccompContent);
} catch (err) {
  console.error(`ERROR: seccomp profile is not valid JSON: ${seccompPath}`);
  console.error(err.message);
  process.exit(1);
}

// Ensure output directory exists
mkdirSync(join(projectRoot, 'release'), { recursive: true });

await build({
  entryPoints: [join(projectRoot, 'dist', 'cli.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  minify: true,
  outfile: join(projectRoot, 'release', 'awf-bundle.js'),
  format: 'cjs',
  // The shebang is added via a write-after step below rather than esbuild
  // banner, because esbuild banner + an existing shebang in the entry point
  // can produce a duplicate shebang that breaks `node` execution.
  define: {
    __AWF_SECCOMP_PROFILE__: JSON.stringify(seccompContent),
  },
  // Mark native/optional deps as external if needed
  // (none expected — all deps are pure JS)
});

// Prepend shebang so the file is directly executable
const outPath = join(projectRoot, 'release', 'awf-bundle.js');
const bundleContent = readFileSync(outPath, 'utf-8');
if (!bundleContent.startsWith('#!')) {
  writeFileSync(outPath, '#!/usr/bin/env node\n' + bundleContent);
}

// Set executable permission so ./release/awf-bundle.js works directly
chmodSync(outPath, 0o755);

console.log('Bundle created: release/awf-bundle.js');
