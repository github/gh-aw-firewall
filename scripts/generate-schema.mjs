#!/usr/bin/env node

/**
 * Generates the JSON Schema files for AWF.
 *
 * Usage:
 *   node scripts/generate-schema.mjs                          # writes docs/awf-config.schema.json and src/awf-config-schema.json
 *   node scripts/generate-schema.mjs --version v0.26.0        # embeds a versioned $id in release output
 *   node scripts/generate-schema.mjs --print                  # prints awf-config schema to stdout
 *
 * Output files (non-print mode):
 *   docs/awf-config.schema.json     — config schema (canonical source)
 *   src/awf-config-schema.json      — bundleable copy for runtime validation
 *   schemas/audit.schema.json       — audit JSONL schema with versioned $id
 *   schemas/token-usage.schema.json — token-usage JSONL schema with versioned $id
 *
 * The schema version is embedded in the $id URL using the repo release tag.
 * The schema reflects the validated config surface defined in src/config-file.ts
 * (validateAwfFileConfig), not just the AwfFileConfig TypeScript interface.
 * When validation rules change (e.g. new fields, enum constraints), update this script to match.
 */

import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// --- Parse CLI args ---
const args = process.argv.slice(2);

const knownFlags = new Set(['--version', '--print']);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (!knownFlags.has(arg)) {
    // Skip the value that follows --version
    if (args[i - 1] === '--version') continue;
    console.error(`Error: unknown argument '${arg}'`);
    console.error('Usage: generate-schema.mjs [--version <vX.Y.Z>] [--print]');
    process.exit(1);
  }
}

const versionIdx = args.indexOf('--version');
if (versionIdx !== -1 && (versionIdx + 1 >= args.length || args[versionIdx + 1].startsWith('--'))) {
  console.error('Error: --version requires a value (e.g. --version v0.23.1)');
  console.error('Usage: generate-schema.mjs [--version <vX.Y.Z>] [--print]');
  process.exit(1);
}
const version = versionIdx !== -1 ? args[versionIdx + 1] : null;
const printOnly = args.includes('--print');

// --- Build the schema ---
// Config schema $id (release URL when version provided, raw URL otherwise)
const schemaConfigId = version
  ? `https://github.com/github/gh-aw-firewall/releases/download/${version}/awf-config.schema.json`
  : 'https://raw.githubusercontent.com/github/gh-aw-firewall/main/docs/awf-config.schema.json';

// JSONL schema $id for audit records
const schemaAuditId = version
  ? `https://github.com/github/gh-aw-firewall/releases/download/${version}/audit.schema.json`
  : 'https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/audit.schema.json';

// JSONL schema $id for token-usage records
const schemaTokenUsageId = version
  ? `https://github.com/github/gh-aw-firewall/releases/download/${version}/token-usage.schema.json`
  : 'https://raw.githubusercontent.com/github/gh-aw-firewall/main/schemas/token-usage.schema.json';

function buildConfigSchema(newId) {
  const schemaPath = join(projectRoot, 'docs', 'awf-config.schema.json');
  let raw;
  try {
    raw = readFileSync(schemaPath, 'utf8');
  } catch (err) {
    console.error(`Error: could not read schema file '${schemaPath}': ${err.message}`);
    process.exit(1);
  }

  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: could not parse JSON in '${schemaPath}': ${err.message}`);
    process.exit(1);
  }

  schema.$id = newId;
  return JSON.stringify(schema, null, 2) + '\n';
}

// Read JSONL schemas from the schemas/ directory and update their $id fields
function buildJsonlSchema(schemaFile, newId) {
  const schemaDir = join(projectRoot, 'schemas');
  const schemaPath = join(schemaDir, schemaFile);
  let raw;
  try {
    raw = readFileSync(schemaPath, 'utf8');
  } catch (err) {
    console.error(`Error: could not read schema file '${schemaPath}': ${err.message}`);
    process.exit(1);
  }
  let schema;
  try {
    schema = JSON.parse(raw);
  } catch (err) {
    console.error(`Error: could not parse JSON in '${schemaPath}': ${err.message}`);
    process.exit(1);
  }
  schema.$id = newId;
  return JSON.stringify(schema, null, 2) + '\n';
}

const outputConfig = buildConfigSchema(schemaConfigId);

if (printOnly) {
  // --print emits the config schema to stdout
  process.stdout.write(outputConfig);
} else {
  const docsDir = join(projectRoot, 'docs');
  mkdirSync(docsDir, { recursive: true });

  // Config schema
  const configPath = join(docsDir, 'awf-config.schema.json');
  writeFileSync(configPath, outputConfig);
  console.log(`Schema written to ${configPath}`);

  // Also write to src/ for runtime loading (loaded dynamically by schema-validator.ts at startup)
  const srcPath = join(projectRoot, 'src', 'awf-config-schema.json');
  writeFileSync(srcPath, outputConfig);
  console.log(`Schema written to ${srcPath}`);

  // JSONL schemas — update $id with release/raw URL
  const schemasDir = join(projectRoot, 'schemas');
  mkdirSync(schemasDir, { recursive: true });

  const auditOutput = buildJsonlSchema('audit.schema.json', schemaAuditId);
  const auditPath = join(schemasDir, 'audit.schema.json');
  writeFileSync(auditPath, auditOutput);
  console.log(`Schema written to ${auditPath}`);

  const tokenUsageOutput = buildJsonlSchema('token-usage.schema.json', schemaTokenUsageId);
  const tokenUsagePath = join(schemasDir, 'token-usage.schema.json');
  writeFileSync(tokenUsagePath, tokenUsageOutput);
  console.log(`Schema written to ${tokenUsagePath}`);
}
