'use strict';

const approvedSources = require('./maintenance-sources.json');

const file = 'shared/model-information/sources/native-protocols.json';
const exactId = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/i;
const validStates = new Set(['supported', 'unsupported', 'unknown', 'conditional']);
const agentProtocols = new Set(['chat_completions', 'responses', 'messages']);
const providerProtocols = Object.freeze({
  openai: new Set(['chat_completions', 'responses']),
  anthropic: new Set(['messages']),
});
const providerSourceIds = Object.freeze({
  openai: new Set(['openai-models', 'openai-responses']),
  anthropic: new Set(['anthropic-models']),
});
const approvedUrlsBySource = new Map(approvedSources.map(source => [source.id, source.urls]));

function protocolEntries(document, sourceFile, { strict = sourceFile === file } = {}) {
  const entries = new Map();
  for (const model of document?.models || []) {
    const provider = model?.identity?.provider;
    const rawId = model?.identity?.rawId;
    const key = model?.identity?.key;
    if (!Object.hasOwn(providerProtocols, provider)) {
      if (strict) throw new Error(`${sourceFile}: unsupported native protocol provider ${provider}`);
      continue;
    }
    const allowedProtocols = providerProtocols[provider];
    const seen = new Set();
    for (const item of model.protocols || []) {
      const protocol = item?.protocol;
      const state = item?.support?.state;
      if (!strict && !agentProtocols.has(protocol)) continue;
      if (typeof rawId !== 'string' || !exactId.test(rawId) || key !== `${provider}/${rawId}`) {
        throw new Error(`${sourceFile}: expected exact provider-qualified model ID, got ${key}`);
      }
      if (!allowedProtocols.has(protocol) || !validStates.has(state)) {
        throw new Error(`${sourceFile}: invalid protocol fact ${key} ${protocol}=${state}`);
      }
      if (seen.has(protocol)) {
        throw new Error(`${sourceFile}: duplicate protocol ${protocol} for ${key}`);
      }
      seen.add(protocol);
      entries.set(`${key}\0${protocol}`, {
        model: key,
        provider,
        rawId,
        protocol,
        state,
        provenance: item.support?.provenance || null,
        raw: item,
      });
    }
    if (strict && (typeof rawId !== 'string' || !exactId.test(rawId) || key !== `${provider}/${rawId}`)) {
      throw new Error(`${sourceFile}: expected exact provider-qualified model ID, got ${key}`);
    }
  }
  return entries;
}

function changes(before, after, sourceFile = file) {
  const strict = sourceFile === file;
  const old = protocolEntries(before, sourceFile, { strict });
  const next = protocolEntries(after, sourceFile, { strict });
  const result = [];
  for (const entryKey of [...new Set([...old.keys(), ...next.keys()])].sort()) {
    const prev = old.get(entryKey);
    const curr = next.get(entryKey);
    const from = prev?.state ?? null;
    const to = curr?.state ?? null;
    if (prev && curr && JSON.stringify(prev.raw) === JSON.stringify(curr.raw)) continue;
    const meta = curr || prev;
    const supportChanged = Boolean(curr) && (
      !prev || JSON.stringify(prev.raw?.support) !== JSON.stringify(curr.raw?.support)
    );
    const changedFeatureProvenances = [];
    if (curr?.raw?.features && typeof curr.raw.features === 'object') {
      for (const [featureName, featureValue] of Object.entries(curr.raw.features)) {
        if (JSON.stringify(prev?.raw?.features?.[featureName]) !== JSON.stringify(featureValue)) {
          changedFeatureProvenances.push({
            feature: featureName,
            provenance: featureValue?.provenance || null,
          });
        }
      }
    }
    result.push({
      model: meta.model,
      provider: meta.provider,
      rawId: meta.rawId,
      protocol: meta.protocol,
      before: from,
      after: to,
      supportChanged,
      provenance: curr?.provenance ?? null,
      changedFeatureProvenances,
    });
  }
  return result;
}

function matchesReceipt(change, receipt) {
  return receipt &&
    receipt.model === change.model &&
    receipt.protocol === change.protocol &&
    receipt.after === change.after;
}

function isNativeProtocolReceipt(receipt) {
  return receipt && (
    receipt.model !== undefined ||
    receipt.protocol !== undefined ||
    receipt.after !== undefined
  );
}

function verifyChanges(before, after, receipts, captures, sourceFile = file) {
  const strict = sourceFile === file;
  const delta = changes(before, after, sourceFile);
  if (!delta.length) {
    if (strict) {
      const allProviderSources = new Set([
        ...providerSourceIds.openai,
        ...providerSourceIds.anthropic,
      ]);
      for (const receipt of receipts) {
        if (!allProviderSources.has(receipt.source)) {
          throw new Error(`${sourceFile}: ${receipt.source} is not an approved native provider evidence source`);
        }
      }
    }
    return [];
  }
  const relevantReceipts = strict ? receipts : receipts.filter(isNativeProtocolReceipt);
  for (const receipt of relevantReceipts) {
    const change = delta.find(item => matchesReceipt(item, receipt));
    if (!change) {
      throw new Error('Native protocol receipt must bind a changed model, protocol, and state to its captured citation');
    }
    if (!providerSourceIds[change.provider].has(receipt.source)) {
      throw new Error(`${change.model}: ${receipt.source} is not an approved ${change.provider} protocol evidence source`);
    }
    const capture = captures.find(item => item.id === receipt.source);
    if (!capture || !approvedUrlsBySource.get(receipt.source)?.includes(receipt.url) || receipt.url !== capture.url) {
      throw new Error(`${change.model}: native protocol receipt URL must match captured ${receipt.source}`);
    }
  }
  return delta.map(change => {
    const matching = relevantReceipts.filter(receipt => matchesReceipt(change, receipt));
    if (!matching.length) {
      throw new Error(`${change.model}: missing provider-qualified evidence for ${change.protocol} (${change.before} -> ${change.after})`);
    }
    const evidence = matching.map(receipt => {
      const capture = captures.find(item => item.id === receipt.source);
      return {
        source: receipt.source,
        url: capture.url,
        quote: receipt.quote,
        sha256: capture.sha256,
      };
    });
    if (change.after !== null) {
      if (change.supportChanged) {
        const matchesSupportProvenance = evidence.some(item =>
          change.provenance?.source === item.url && change.provenance?.revision === item.sha256);
        if (!matchesSupportProvenance) {
          throw new Error(`${change.model}: stored provenance for ${change.protocol} must match captured source URL and revision`);
        }
      }
      for (const { feature, provenance: featureProvenance } of change.changedFeatureProvenances) {
        const matchesFeatureProvenance = evidence.some(item =>
          featureProvenance?.source === item.url && featureProvenance?.revision === item.sha256);
        if (!matchesFeatureProvenance) {
          throw new Error(`${change.model}: stored provenance for ${change.protocol} feature ${feature} must match captured source URL and revision`);
        }
      }
    }
    const { provenance, supportChanged, changedFeatureProvenances, ...summary } = change;
    return { ...summary, evidence };
  });
}

function samePendingFact(change, item) {
  return item &&
    item.model === change.model &&
    item.protocol === change.protocol &&
    item.after === change.after;
}

function pendingChanges(before, after, current, previous, sourceFile = file) {
  return changes(before, after, sourceFile).map(change => {
    const matchingFacts = [...current, ...previous].filter(item => samePendingFact(change, item));
    const seen = new Set();
    const evidence = [];
    for (const fact of matchingFacts) {
      if (!Array.isArray(fact?.evidence)) continue;
      for (const item of fact.evidence) {
        const key = JSON.stringify(item);
        if (seen.has(key)) continue;
        seen.add(key);
        evidence.push(item);
      }
    }
    if (!evidence.length ||
        evidence.some(item => !item ||
          !providerSourceIds[change.provider].has(item.source) ||
          !approvedUrlsBySource.get(item.source)?.includes(item.url) ||
          typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256) ||
          typeof item.quote !== 'string' || item.quote.trim().length < 20)) {
      throw new Error(`${change.model}: missing evidence for pending ${change.protocol}`);
    }
    if (change.after !== null) {
      if (change.supportChanged && !evidence.some(item =>
        change.provenance?.source === item.url && change.provenance?.revision === item.sha256)) {
        throw new Error(`${change.model}: missing evidence for pending ${change.protocol}`);
      }
      for (const { provenance: featureProvenance } of change.changedFeatureProvenances) {
        if (!evidence.some(item =>
          featureProvenance?.source === item.url && featureProvenance?.revision === item.sha256)) {
          throw new Error(`${change.model}: missing evidence for pending ${change.protocol}`);
        }
      }
    }
    const { provenance, supportChanged, changedFeatureProvenances, ...summary } = change;
    return { ...summary, evidence };
  });
}

module.exports = { file, providerProtocols, providerSourceIds, changes, verifyChanges, pendingChanges };
