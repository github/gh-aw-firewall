#!/usr/bin/env node
/**
 * CLI for the canonical AWF diagnosis registry.
 *
 *   npx tsx scripts/diagnostics/cli.ts validate
 *   npx tsx scripts/diagnostics/cli.ts search "TCP_DENIED" --boundary network
 *   npx tsx scripts/diagnostics/cli.ts render
 *   npx tsx scripts/diagnostics/cli.ts check-sync
 */

import {
  checkSync,
  loadFindings,
  searchFindings,
  validateFindings,
  writeOutputs,
  SearchQuery,
} from './registry';

const SEARCH_DIMENSIONS = ['boundary', 'runner', 'runtime', 'provider', 'authMode'] as const;

/** Parse search arguments, rejecting unknown flags and invalid limits. */
function parseSearchArgs(args: string[]): SearchQuery {
  const query: SearchQuery = {};
  const text: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      text.push(arg);
      continue;
    }

    const key = arg.slice(2);
    const value = args[++i];
    if (value === undefined) {
      throw new Error(`Missing value for --${key}`);
    }
    if (key === 'limit') {
      const limit = Number(value);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error(`--limit must be a positive integer, received "${value}"`);
      }
      query.limit = limit;
      continue;
    }
    if (!(SEARCH_DIMENSIONS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown option --${key}. Supported: --limit, ${SEARCH_DIMENSIONS.map((d) => `--${d}`).join(', ')}`
      );
    }
    (query as Record<string, unknown>)[key] = value;
  }
  if (text.length > 0) query.text = text.join(' ');
  return query;
}

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  const loaded = loadFindings();

  switch (command) {
    case 'validate': {
      const errors = validateFindings(loaded);
      if (errors.length > 0) {
        console.error(`Registry validation failed (${errors.length} error(s)):`);
        for (const error of errors) console.error(`  - ${error}`);
        return 1;
      }
      console.log(`Registry valid: ${loaded.length} finding(s).`);
      return 0;
    }
    case 'search': {
      let matches;
      try {
        matches = searchFindings(loaded, parseSearchArgs(args));
      } catch (error) {
        console.error((error as Error).message);
        return 2;
      }
      if (matches.length === 0) {
        console.log('No matching finding. Collect the smallest missing evidence instead of guessing.');
        return 0;
      }
      console.log(JSON.stringify(matches, null, 2));
      return 0;
    }
    case 'render': {
      for (const written of writeOutputs(loaded)) console.log(`wrote ${written}`);
      return 0;
    }
    case 'check-sync': {
      const { stale } = checkSync(loaded);
      if (stale.length > 0) {
        console.error('Generated diagnosis artifacts are stale. Run: npm run diagnostics:render');
        for (const file of stale) console.error(`  - ${file}`);
        return 1;
      }
      console.log('Generated diagnosis artifacts are in sync.');
      return 0;
    }
    default:
      console.error('Usage: cli.ts <validate|search|render|check-sync> [args]');
      return 2;
  }
}

process.exitCode = main();
