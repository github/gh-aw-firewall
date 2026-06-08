'use strict';

// Per-model pricing in dollars per 1M tokens.
// Source: https://models.dev/catalog.json
module.exports = Object.freeze({
  'gpt-5-mini':        { input: 0.25,  cachedInput: 0.025, cacheWrite: null, output: 2.00 },
  'gpt-5-codex-mini':  { input: 0.25,  cachedInput: 0.025, cacheWrite: null, output: 2.00 },
  'gpt-5.2':           { input: 1.75,  cachedInput: 0.175, cacheWrite: null, output: 14.00 },
  'gpt-5.2-codex':     { input: 1.75,  cachedInput: 0.175, cacheWrite: null, output: 14.00 },
  'gpt-5.3-codex':     { input: 1.75,  cachedInput: 0.175, cacheWrite: null, output: 14.00 },
  'gpt-5.4':           { input: 2.50,  cachedInput: 0.25,  cacheWrite: null, output: 15.00 },
  'gpt-5.4-mini':      { input: 0.75,  cachedInput: 0.075, cacheWrite: null, output: 4.50 },
  'gpt-5.4-nano':      { input: 0.20,  cachedInput: 0.02,  cacheWrite: null, output: 1.25 },
  'gpt-5.5':           { input: 5.00,  cachedInput: 0.50,  cacheWrite: null, output: 30.00 },
  'claude-haiku-4-5':  { input: 1.00,  cachedInput: 0.10,  cacheWrite: 1.25, output: 5.00 },
  'claude-sonnet-4':   { input: 3.00,  cachedInput: 0.30,  cacheWrite: 3.75, output: 15.00 },
  'claude-sonnet-4-5': { input: 3.00,  cachedInput: 0.30,  cacheWrite: 3.75, output: 15.00 },
  'claude-sonnet-4-6': { input: 3.00,  cachedInput: 0.30,  cacheWrite: 3.75, output: 15.00 },
  'claude-opus-4-5':   { input: 5.00,  cachedInput: 0.50,  cacheWrite: 6.25, output: 25.00 },
  'claude-opus-4-6':   { input: 5.00,  cachedInput: 0.50,  cacheWrite: 6.25, output: 25.00 },
  'claude-opus-4-7':   { input: 5.00,  cachedInput: 0.50,  cacheWrite: 6.25, output: 25.00 },
  'claude-opus-4-8':   { input: 5.00,  cachedInput: 0.50,  cacheWrite: 6.25, output: 25.00 },
  'gemini-2.5-pro':    { input: 1.25,  cachedInput: 0.125, cacheWrite: null, output: 10.00 },
  'gemini-3-flash':    { input: 0.50,  cachedInput: 0.05,  cacheWrite: null, output: 3.00 },
  'gemini-3.1-pro':    { input: 2.00,  cachedInput: 0.20,  cacheWrite: null, output: 12.00 },
  'gemini-3.5-flash':  { input: 1.50,  cachedInput: 0.15,  cacheWrite: null, output: 9.00 },
  'mai-code-1-flash':  { input: 0.75,  cachedInput: 0.075, cacheWrite: null, output: 4.50 },
  'raptor-mini':       { input: 0.25,  cachedInput: 0.025, cacheWrite: null, output: 2.00 },
});
