'use strict';

const sourceFiles = ['copilot-main', 'copilot-claude', 'copilot-gemini', 'copilot-other']
  .map(name => `shared/model-information/sources/${name}.json`);
const targetFile = 'shared/model-information/sources/target.json';
const scope = { provider: 'copilot', channel: 'copilot-api' };
const components = ['input', 'cachedInput', 'cacheWrite', 'output'];
const columns = { input: 'Input', cachedInput: 'Cached input', cacheWrite: 'Cache write', output: 'Output' };
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const copilotTariff = tariff => tariff.scope.provider === 'copilot' &&
  tariff.scope.channel === 'copilot-api' && !tariff.scope.deployment;
// Reviewed display-name mappings for new records; these convey no CLI eligibility.
const newIdentities = {
  'GPT-6.1 Terra': ['gpt-6.1-terra', sourceFiles[0]],
  'Gemini 3.8 Flash': ['gemini-3.8-flash', sourceFiles[2]],
  'Gemini 4 Argon': ['gemini-4-argon', sourceFiles[2]],
  'MAI-Code-1.1-Flash': ['mai-code-1.1-flash', sourceFiles[3]],
};
const normalizeName = value => value.toLowerCase().replace(/[ ._-]+/g, '-');
const decimal = value => {
  const match = /^\$(0|[1-9]\d*)(\.\d+)?$/.exec(value);
  if (!match) throw new Error(`Missing or ambiguous numeric price: ${value || '(empty)'}`);
  return value.slice(1).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};
const cleanHtml = bytes => {
  let html = bytes.toString('utf8');
  let previous;
  do {
    previous = html;
    html = html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  } while (html !== previous);
  return html;
};

function tables(bytes, text) {
  return [...cleanHtml(bytes).matchAll(/<table\b([^>]*)>([\s\S]*?)<\/table>/gi)].map(match => {
    const rows = [...match[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(row => {
      const cells = [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)];
      return {
        cells: cells.map(cell => text(Buffer.from(cell[1].replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, '')))),
        footnotes: [...row[1].matchAll(/href=["']#(user-content-fn-[^"']+)["']/g)].map(note => note[1]),
        quote: text(Buffer.from(row[0])),
      };
    });
    return {
      owner: /aria-labelledby=["']([^"']+)["']/.exec(match[1])?.[1],
      headers: rows[0]?.cells || [], rows: rows.slice(1),
    };
  });
}

function extractPricingTables(bytes, text) {
  const html = cleanHtml(bytes);
  const result = tables(bytes, text).filter(table => table.headers.includes('Input') &&
    table.headers.includes('Model'));
  if (!result.length || !/per 1 million tokens/i.test(text(Buffer.from(html))) ||
      !/GitHub Copilot/.test(text(Buffer.from(html)))) {
    throw new Error('Copilot pricing tables or explicit per-million-token units missing');
  }
  const entries = [...html.matchAll(/<li\b[^>]*id=["'](user-content-fn-[^"']+)["'][^>]*>([\s\S]*?)<\/li>/gi)];
  if (new Set(entries.map(note => note[1])).size !== entries.length) {
    throw new Error('Ambiguous duplicate Copilot pricing footnote IDs');
  }
  const notes = Object.fromEntries(entries.map(note => [note[1],
    text(Buffer.from(note[2].replace(/<a\b[^>]*data-footnote-backref[^>]*>[\s\S]*?<\/a>/gi, '')))]));
  return { tables: result, footnotes: notes };
}

function promotion(row, notes, prices) {
  if (!row.footnotes.length) return {};
  const attached = row.footnotes.map(id => {
    if (!notes[id]) throw new Error(`Missing attached footnote ${id}`);
    return notes[id];
  });
  if (attached.length !== 1) throw new Error('Ambiguous multiple pricing footnotes');
  const note = attached[0];
  const pattern = /promotional pricing of \$(\d+(?:\.\d+)?) per 1M input tokens, \$(\d+(?:\.\d+)?) per 1M cached input tokens, and \$(\d+(?:\.\d+)?) per 1M output tokens (through|until) ([A-Za-z]+ \d{1,2}, \d{4})\./;
  const match = pattern.exec(note);
  if (!match || match.index === 0 || !note.startsWith(`${row.cells[0]} is available at the `) ||
      match[0].length + match.index !== note.length) {
    throw new Error('Ambiguous promotion/successor footnote; prior facts retained');
  }
  for (const [index, component] of ['input', 'cachedInput', 'output'].entries()) {
    if (decimal(`$${match[index + 1]}`) !== prices[component]) {
      throw new Error(`Conflicting promotional ${component} component`);
    }
  }
  const date = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(match[5]);
  const month = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'].indexOf(date[1]);
  const day = Number(date[2]);
  const year = Number(date[3]);
  const start = Date.UTC(year, month, day);
  const parsed = new Date(start);
  if (month < 0 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month ||
      parsed.getUTCDate() !== day) throw new Error('Invalid promotion end date');
  const effectiveUntil = new Date(start + (match[4] === 'through' ? 86400000 : 0)).toISOString();
  return {
    effectiveUntil, promotion: `${row.cells[0]} published promotional pricing`,
    boundaryInterpretation: {
      publishedCalendarEnd: `${match[4]} ${match[5]}`,
      publishedTimezone: 'not specified by source',
      reviewedPolicy: 'Interpret through as inclusive calendar date and until as exclusive calendar date; normalize the exclusive boundary to UTC. The source does not publish this UTC instant.',
      normalizedExclusiveEnd: effectiveUntil,
    },
  };
}

function observedTariff(table, row, notes) {
  const headers = table.headers;
  if (new Set(headers).size !== headers.length || row.cells.length !== headers.length) {
    throw new Error('Incomplete or ambiguous pricing row/columns');
  }
  const get = name => row.cells[headers.indexOf(name)];
  const tier = get('Tier') || (headers.includes('Tier') ? '' : 'Default');
  if (!['Default', 'Long context'].includes(tier)) throw new Error(`Unsupported pricing tier: ${tier}`);
  const thresholdText = get('Threshold (input tokens)');
  if (headers.includes('Threshold (input tokens)') && !thresholdText) {
    throw new Error('Input-token threshold component missing');
  }
  let threshold;
  if (thresholdText && thresholdText !== 'Not applicable') {
    const match = /^(≤|>) ([1-9][\d,]*)(K)?$/.exec(thresholdText);
    if (!match || (tier === 'Default' ? match[1] !== '≤' : match[1] !== '>')) {
      throw new Error(`Ambiguous input-token threshold: ${thresholdText}`);
    }
    threshold = Number(match[2].replace(/,/g, '')) * (match[3] ? 1000 : 1);
    if (!Number.isSafeInteger(threshold)) throw new Error('Invalid input-token threshold');
  } else if (tier === 'Long context') throw new Error('Long-context threshold missing');
  const prices = {};
  for (const component of components) {
    const cell = get(columns[component]);
    if (component === 'cacheWrite' && ((!headers.includes(columns[component]) &&
        ['google', 'microsoft'].includes(table.owner)) || cell === 'Not applicable' || cell === 'Unavailable')) {
      prices[component] = { unavailable: true };
    } else prices[component] = decimal(cell || '');
  }
  return {
    tier: tier === 'Default' ? 'default' : 'long_context', threshold, prices,
    ...promotion(row, notes, prices), quote: row.quote,
    footnotes: row.footnotes.map(id => notes[id]),
  };
}

function semanticTariff(tariff) {
  const price = value => typeof value === 'string'
    ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : value;
  return {
    currency: tariff.currency, unit: tariff.unit, tier: tariff.tier, promptTokensAbove: tariff.promptTokensAbove,
    effectiveFrom: tariff.effectiveFrom ? new Date(tariff.effectiveFrom).toISOString() : undefined,
    effectiveUntil: tariff.effectiveUntil ? new Date(tariff.effectiveUntil).toISOString() : undefined,
    promotion: Boolean(tariff.promotion), successor: tariff.successor,
    components: Object.fromEntries([...components, 'reasoning']
      .map(key => [key, price(tariff.components?.[key]?.price)])),
  };
}

function planCopilotPricing(documents, pricingCapture, modelsCapture, pricingBytes, modelsBytes, text) {
  const extracted = extractPricingTables(pricingBytes, text);
  const modelColumn = table => table.headers.includes('Model name') ? 'Model name' : 'Model';
  const supported = tables(modelsBytes, text).filter(table =>
    table.headers.includes(modelColumn(table)) && table.headers.includes('Release status'));
  const supportedNames = new Set(supported.flatMap(table => table.rows
    .filter(row => row.cells[table.headers.indexOf('Release status')] === 'GA')
    .map(row => row.cells[table.headers.indexOf(modelColumn(table))])));
  if (!supportedNames.size) throw new Error('Copilot GA model coverage missing; prior facts retained');
  const updates = new Map();
  const diagnostics = [];
  const receipts = new Map();
  const changedModels = [];
  const allModels = sourceFiles.flatMap(file => (documents[file]?.models || []).map(model => ({ file, model })));
  const groups = new Map();
  for (const table of extracted.tables) for (const row of table.rows) {
    const name = row.cells[table.headers.indexOf('Model')];
    if (!name) {
      diagnostics.push({ source: pricingCapture.id, model: `(unnamed ${table.owner || 'unknown'} row)`,
        status: 'retained-prior-facts', message: 'Incomplete pricing row has no model identity' });
      continue;
    }
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push({ table, row });
  }
  const sanitizeReceiptQuote = value => String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/```/g, '`\\`\\`')
    .replace(/^\s*(system|assistant|developer|user|tool)\s*:/gim, '[redacted-role]:')
    .replace(/\s+/g, ' ')
    .trim();
  const receipt = (capture, quote, fields) => ({
    source: capture.id, url: capture.url, sha256: capture.sha256,
    retrievedAt: capture.retrievedAt, quote: sanitizeReceiptQuote(quote), ...fields,
  });
  for (const [name, rows] of [...groups.entries()].sort(([a], [b]) => compare(a, b))) {
    const matches = allModels.filter(({ model }) => normalizeName(model.identity.rawId) === normalizeName(name));
    const reviewed = newIdentities[name];
    const id = matches.length === 1 ? matches[0].model.identity.rawId : reviewed?.[0];
    const fail = message => diagnostics.push({ source: pricingCapture.id, model: id || name, status: 'retained-prior-facts', message });
    if (!supportedNames.has(name) || rows.some(({ table, row }) =>
      row.cells[table.headers.indexOf('Release status')] !== 'GA')) {
      fail('Not unambiguously GA in both Copilot sources'); continue;
    }
    if (/^grok-/i.test(id || name)) { fail('Grok activation remains separately reviewed in #10029'); continue; }
    if (matches.length > 1 || !id) { fail('Uncertain exact Copilot model-ID mapping'); continue; }
    const existing = matches[0]?.model;
    const file = matches[0]?.file || reviewed[1];
    if (existing && (existing.modelType !== 'completion' || existing.lifecycle.status !== 'active')) {
      fail('Only active Copilot completion records are in scope'); continue;
    }
    let observed;
    try {
      observed = rows.map(({ table, row }) => observedTariff(table, row, extracted.footnotes));
      const defaults = observed.filter(row => row.tier === 'default');
      const longs = observed.filter(row => row.tier === 'long_context');
      if (defaults.length !== 1 || longs.length > 1 || ((longs.length || defaults[0].threshold !== undefined) &&
          (longs.length !== 1 || longs[0].threshold !== defaults[0].threshold))) {
        throw new Error('Incomplete or conflicting default/long-context row pair');
      }
    } catch (error) { fail(error.message); continue; }
    const provenance = {
      authority: 'maintained', source: pricingCapture.url, revision: pricingCapture.sha256,
      at: pricingCapture.retrievedAt, confidence: 'verified',
    };
    const oldTariffs = existing?.tariffs || [];
    const nextTariffs = oldTariffs.filter(tariff => !copilotTariff(tariff));
    let changed = false;
    const modelReceipts = [];
    for (const observedRow of observed.sort((a, b) => compare(a.tier, b.tier))) {
      const candidate = {
        scope, currency: 'USD', unit: 'USD_PER_1M_TOKENS', tier: observedRow.tier,
        ...(observedRow.tier === 'long_context' ? { promptTokensAbove: observedRow.threshold } : {}),
        ...(observedRow.effectiveUntil ? { effectiveUntil: observedRow.effectiveUntil, promotion: observedRow.promotion } : {}),
        components: Object.fromEntries(components.map(component => [component, {
          price: observedRow.prices[component], provenance,
        }])), provenance,
      };
      const old = oldTariffs.filter(tariff => copilotTariff(tariff) && tariff.tier === candidate.tier);
      if (old.length > 1 || oldTariffs.some(tariff => copilotTariff(tariff) &&
          (!['default', 'long_context'].includes(tariff.tier) || tariff.effectiveFrom || tariff.successor))) {
        fail('Existing dated/successor tariff needs explicit reconciliation'); changed = false; observed = null; break;
      }
      if (old.some(tariff => tariff.effectiveUntil) && !candidate.effectiveUntil) {
        fail('Previously documented promotion interval absent; explicit reconciliation required');
        changed = false; observed = null; break;
      }
      if (old.length && old[0].components.reasoning &&
          semanticTariff(old[0]).components.output !== semanticTariff(candidate).components.output) {
        if (semanticTariff(old[0]).components.reasoning !== semanticTariff(old[0]).components.output) {
          fail('Output changed while the reasoning-rate relationship is unverified; prior tariff retained');
          changed = false; observed = null; break;
        }
        candidate.components.reasoning = candidate.components.output;
      }
      if (old.length && old[0].components.reasoning && !candidate.components.reasoning) {
        candidate.components.reasoning = old[0].components.reasoning;
      }
      if (old.length && JSON.stringify(semanticTariff(old[0])) === JSON.stringify(semanticTariff(candidate))) {
        nextTariffs.push(old[0]); continue;
      }
      changed = true;
      if (old.length) {
        candidate.components = { ...old[0].components, ...candidate.components };
        for (const component of components) {
          if (JSON.stringify(semanticTariff(old[0]).components[component]) ===
              JSON.stringify(observedRow.prices[component])) candidate.components[component] = old[0].components[component];
        }
      }
      nextTariffs.push(candidate);
      modelReceipts.push(receipt(pricingCapture, observedRow.quote, {
        model: id, tariff: candidate.tier, components,
      }), ...observedRow.footnotes.map(quote => receipt(pricingCapture, quote, {
        model: id, tariff: candidate.tier, fields: ['effectiveUntil', 'promotion'],
        successor: 'not-published', boundaryInterpretation: observedRow.boundaryInterpretation,
      })));
    }
    if (!observed) continue;
    for (const row of observed.filter(item => item.promotion)) diagnostics.push({
      source: pricingCapture.id, model: id, status: 'promotion-without-successor',
      message: `Published calendar end: ${row.boundaryInterpretation.publishedCalendarEnd}; reviewed UTC boundary interpretation: ${row.effectiveUntil} (not a page-published UTC instant). No successor published; ordinary fallback applies after expiry`,
      boundaryInterpretation: row.boundaryInterpretation,
    });
    if (!changed) continue;
    // A disappeared tier is not evidence that the prior tariff ceased to apply.
    const missing = oldTariffs.filter(tariff => copilotTariff(tariff) &&
      !observed.some(row => row.tier === tariff.tier));
    if (missing.length) { fail('Previously maintained tier absent; explicit reconciliation required'); continue; }
    const document = updates.get(file) || structuredClone(documents[file]);
    if (!document) { fail('Canonical source file missing'); continue; }
    const model = existing ? { ...existing, tariffs: nextTariffs, provenance } : {
      schemaVersion: 1, identity: { key: `copilot/${id}`, provider: 'copilot', rawId: id,
        lookupId: id.replace(/[._]/g, '-') }, lifecycle: { status: 'active' },
      modelType: 'completion', tariffs: nextTariffs, provenance,
    };
    const index = document.models.findIndex(item => item.identity.rawId === id);
    if (index >= 0) document.models[index] = model;
    else document.models.push(model);
    updates.set(file, document);
    const gaEntry = supported.flatMap(table => table.rows.map((row, index) => ({ table, row, index })))
      .find(({ table, row }) => row.cells[table.headers.indexOf(modelColumn(table))] === name &&
        row.cells[table.headers.indexOf('Release status')] === 'GA');
    let gaQuote = gaEntry?.row.quote;
    if (gaQuote && gaQuote.length < 20 && gaEntry) {
      const adjacent = gaEntry.table.rows[gaEntry.index + 1] || gaEntry.table.rows[gaEntry.index - 1];
      if (adjacent) gaQuote = `${gaQuote} ${adjacent.quote}`;
      if (gaQuote.length < 20) gaQuote = `${gaQuote} ${gaEntry.table.headers.join(' ')}`;
    }
    modelReceipts.push(receipt(modelsCapture, gaQuote, { model: id, fields: ['identity', 'lifecycle', 'modelType'] }));
    receipts.set(file, [...(receipts.get(file) || []), ...modelReceipts]);
    changedModels.push(id);
  }
  for (const name of [...supportedNames].sort()) if (!groups.has(name)) diagnostics.push({
    source: pricingCapture.id, model: name, status: 'retained-prior-facts',
    message: 'GA model has no captured pricing row; absence is not retirement or a zero price',
  });
  if (changedModels.includes('gemini-3.8-flash') && documents[targetFile]?.tariffs?.['gemini-3.8-flash']) {
    const target = structuredClone(documents[targetFile]);
    delete target.tariffs['gemini-3.8-flash'];
    updates.set(targetFile, target);
    receipts.set(targetFile, receipts.get(sourceFiles[2]).filter(item => item.model === 'gemini-3.8-flash'));
  }
  return { updates, receipts, diagnostics, changedModels };
}

module.exports = {
  sourceFiles, targetFile, copilotTariff, extractPricingTables, planCopilotPricing, semanticTariff,
};
