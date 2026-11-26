'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeId } = require('../../containers/api-proxy/catalogue-contract/identity');
const { supportedModelTables, supportedModelNames } = require('./copilot-pricing.cjs');
const approvedSources = require('./maintenance-sources.json');

const file = 'shared/model-information/sources/coding-tiers.json';
const fields = ['codingTier', 'releaseDate'];
const agentProtocols = new Set(['responses', 'chat_completions', 'messages']);
const exactId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const evidenceSources = new Set(['copilot-models', 'copilot-model-comparison', 'copilot-changelog', 'copilot-pricing',
  'openai-models', 'anthropic-models', 'gemini-models', 'xai-models']);
const tierSources = new Map(approvedSources.filter(source => evidenceSources.has(source.id) || source.kind === 'announcement')
  .map(source => [source.id, source.urls]));
const entriesById = doc => new Map(doc.entries.map(entry => [entry.lookupId, entry]));
const lookup = id => normalizeId(id, { caseInsensitive: true, separators: true });
const sameQuote = (a, b) => a.url === b.url && a.quote === b.quote;
const sameField = (a, b) => a.lookupId === b.lookupId && a.field === b.field && a.after === b.after;

function coverage(cwd, directory, text) {
  const read = name => JSON.parse(fs.readFileSync(path.join(cwd, name), 'utf8'));
  const entries = entriesById(read(file));
  const seed = new Set(entries.keys());
  const ids = new Set();
  const copilot = new Set(entries.keys());
  const excluded = new Set();
  const retired = new Set();
  const sources = 'shared/model-information/sources';
  for (const name of fs.readdirSync(path.join(cwd, sources)).filter(name => name.endsWith('.json'))) {
    for (const model of read(path.join(sources, name)).models || []) {
      const { lookupId: id, provider } = model.identity;
      const inactive = ['removed', 'retired'].includes(model.lifecycle.status);
      if (inactive) retired.add(`${provider}/${id}`);
      if (provider === 'openai' || provider === 'anthropic') {
        if (inactive) seed.delete(id);
        if (!inactive && exactId.test(id) && model.provenance.authority === 'maintained' &&
            model.protocols?.some(p => p.support.state === 'supported' && agentProtocols.has(p.protocol))) {
          ids.add(id);
        }
        continue;
      }
      if (provider !== 'copilot') continue;
      const cli = (model.availability || []).filter(item => item.scope.provider === 'copilot' &&
        item.scope.channel === 'copilot-cli' && !item.scope.deployment);
      if (model.modelType !== 'completion' || inactive ||
          cli.some(item => item.fact.state === 'unsupported' || item.picker?.state === 'unsupported')) {
        excluded.add(id);
        seed.delete(id);
        continue;
      }
      copilot.add(id);
      if (cli.some(item => item.fact.state === 'supported')) ids.add(id);
    }
  }
  const gaps = [];
  const names = supportedModelNames(supportedModelTables(fs.readFileSync(path.join(directory, 'copilot-models.raw')), text));
  if (!names.size) gaps.push({ source: 'copilot-models', missing: ['supported model table'] });
  for (const name of names) {
    // A normalized display name may match a reviewed ID, but cannot establish a new wire ID.
    const id = lookup(name.replaceAll(' ', '-'));
    if (excluded.has(id)) continue;
    if (entries.has(id)) ids.add(id);
    else if (!copilot.has(id)) gaps.push({ displayName: name, missing: ['confirmed routable ID'] });
  }
  const { providers } = read('shared/model-information/sources/mapping.json').mapping;
  for (const provider of ['openai', 'anthropic']) {
    for (const model of providers[provider].models) {
      if (!model.endpoints.some(endpoint => agentProtocols.has(endpoint))) continue;
      for (const id of [...model.patterns, ...(model.routingPatterns || [])]) {
        if (exactId.test(id) && !retired.has(`${provider}/${lookup(id)}`)) ids.add(lookup(id));
      }
    }
  }
  for (const lookupId of [...new Set([...seed, ...ids])].sort()) {
    const missing = fields.filter(field => !entries.get(lookupId)?.[field]);
    if (missing.length) gaps.push({ lookupId, missing });
  }
  return gaps;
}

function changes(before, after) {
  const old = entriesById(before);
  const next = entriesById(after);
  const result = [];
  for (const lookupId of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    for (const field of fields) {
      const from = old.get(lookupId)?.[field] ?? null;
      const to = next.get(lookupId)?.[field] ?? null;
      if (from !== to) result.push({ lookupId, field, before: from, after: to });
    }
  }
  return result;
}

function preserveCitations(before, next) {
  for (const entry of before.entries) {
    const remaining = next.get(entry.lookupId)?.evidence;
    if (!remaining || entry.evidence.some(prior => !remaining.some(item => sameQuote(item, prior)))) {
      throw new Error(`${entry.lookupId}: preserve previously reviewed coding tier and release date evidence`);
    }
  }
}

function verifyChanges(before, after, receipts, captures) {
  const delta = changes(before, after);
  if (!delta.length) throw new Error('Coding tier source has no changed model facts');
  const old = entriesById(before);
  const next = entriesById(after);
  preserveCitations(before, next);
  for (const entry of after.entries) {
    const prior = old.get(entry.lookupId)?.evidence || [];
    for (const citation of entry.evidence.filter(item => !prior.some(prev => sameQuote(item, prev)))) {
      if (!receipts.some(r => r.lookupId === entry.lookupId && sameQuote(r, citation))) {
        throw new Error(`${entry.lookupId}: added citation without a field receipt`);
      }
    }
  }
  for (const receipt of receipts) {
    const capture = captures.find(item => item.id === receipt.source);
    if (!delta.some(change => sameField(change, receipt)) || !capture ||
        !tierSources.get(receipt.source)?.includes(receipt.url) || receipt.url !== capture.url ||
        !next.get(receipt.lookupId)?.evidence.some(citation => sameQuote(citation, receipt))) {
      throw new Error('Coding tier receipt must bind a changed model field and value to its captured citation');
    }
  }
  return delta.map(change => {
    const evidence = receipts.filter(receipt => sameField(change, receipt)).map(receipt => ({
      source: receipt.source, url: receipt.url, quote: receipt.quote,
      sha256: captures.find(item => item.id === receipt.source).sha256,
    }));
    if (change.after === null || !evidence.length) {
      throw new Error(`${change.lookupId}: cannot remove or change ${change.field} without supported replacement evidence`);
    }
    return { ...change, evidence };
  });
}

function pendingChanges(before, after, current, previous) {
  const next = entriesById(after);
  preserveCitations(before, next);
  return changes(before, after).map(change => {
    const fact = [...current, ...previous].find(item => sameField(change, item));
    if (change.after === null || !Array.isArray(fact?.evidence) || !fact.evidence.length ||
        fact.evidence.some(item => !item || !tierSources.get(item.source)?.includes(item.url) ||
          typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
          typeof item.quote !== 'string' || item.quote.trim().length < 20 ||
          !next.get(change.lookupId).evidence.some(citation => sameQuote(citation, item)))) {
      throw new Error(`${change.lookupId}: missing evidence for pending ${change.field}`);
    }
    return { ...change, evidence: fact.evidence,
      ...(change.field === 'codingTier' && change.before !== null ? { reviewRequired: 'coding-tier-reclassification' } : {}) };
  });
}

module.exports = { file, coverage, verifyChanges, pendingChanges };
