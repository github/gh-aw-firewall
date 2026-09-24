'use strict';

const LABEL_CHARS = /^[a-z0-9-]+$/;
const DIGITS_ONLY = /^\d+$/;

function isValidDomain(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253) return false;
  const labels = value.split('.');
  if (labels.length < 2 || labels.every(label => DIGITS_ONLY.test(label))) return false;
  return labels.every(label => (
    label.length <= 63 &&
    LABEL_CHARS.test(label) &&
    !label.startsWith('-') &&
    !label.endsWith('-')
  ));
}

function parseHostedWebPolicy(raw, envName) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch (err) {
    throw new Error(`${envName} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${envName} must be a JSON object`);
  }
  if (typeof parsed.enabled !== 'boolean') {
    throw new Error(`${envName}.enabled must be a boolean`);
  }
  if (!parsed.enabled) return { enabled: false, mode: null, domains: [] };
  if (parsed.mode !== 'allow' && parsed.mode !== 'block') {
    throw new Error(`${envName}.mode must be "allow" or "block" when enabled`);
  }
  if (!Array.isArray(parsed.domains) || parsed.domains.length === 0) {
    throw new Error(`${envName}.domains must be a non-empty array when enabled`);
  }
  const domains = [];
  for (const domain of parsed.domains) {
    if (!isValidDomain(domain)) {
      throw new Error(`${envName}.domains contains an invalid domain: ${JSON.stringify(domain)}`);
    }
    if (!domains.includes(domain)) domains.push(domain);
  }
  const policy = { enabled: true, mode: parsed.mode, domains };
  if (parsed.maxUses !== undefined) {
    if (!Number.isInteger(parsed.maxUses) || parsed.maxUses < 1) {
      throw new Error(`${envName}.maxUses must be a positive integer`);
    }
    policy.maxUses = parsed.maxUses;
  }
  return policy;
}

function domainIsWithin(domain, parent) {
  return domain === parent || domain.endsWith(`.${parent}`);
}

function intersectDomains(left, right) {
  return [...new Set(left.flatMap(leftDomain =>
    right.flatMap(rightDomain => {
      if (domainIsWithin(leftDomain, rightDomain)) return [leftDomain];
      if (domainIsWithin(rightDomain, leftDomain)) return [rightDomain];
      return [];
    })))];
}

module.exports = {
  isValidDomain,
  parseHostedWebPolicy,
  domainIsWithin,
  intersectDomains,
};
