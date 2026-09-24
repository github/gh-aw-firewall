'use strict';

const {
  isValidDomain,
  parseHostedWebPolicy,
  domainIsWithin,
  intersectDomains,
} = require('./hosted-web-policy');

const WEB_SEARCH_TOOL = /^web_search(?:_(\d{4})_(\d{2})_(\d{2}))?$/;
const WEB_SEARCH_CANDIDATE = /^web_search(?:_|$)/;
const SEARCH_PATHS = new Set(['/v1/alpha/search', '/alpha/search']);
const SEARCH_COMMANDS = new Set(['search_query', 'image_query', 'open', 'click', 'find', 'screenshot']);
const URL_COMMANDS = new Set(['open', 'find', 'screenshot']);
const FILTER_FIELDS = new Set(['allowed_domains', 'blocked_domains']);
const STANDALONE_FIELDS = new Set(['settings', 'commands']);
const TOOL_FIELDS = new Set([
  'type', 'external_web_access', 'indexed_web_access', 'filters', 'user_location',
  'search_context_size', 'search_content_types', 'image_settings', 'max_uses',
]);
const SETTINGS_FIELDS = new Set([
  'user_location', 'search_context_size', 'filters', 'image_settings',
  'allowed_callers', 'external_web_access',
]);
const COMMAND_FIELDS = {
  search_query: new Set(['q', 'recency', 'domains']),
  image_query: new Set(['q', 'recency', 'domains']),
  open: new Set(['ref_id', 'lineno']),
  click: new Set(['ref_id', 'id']),
  find: new Set(['ref_id', 'pattern']),
  screenshot: new Set(['ref_id', 'pageno']),
};

class CodexHostedWebPolicyError extends Error {
  constructor(code, message, statusCode = 403) {
    super(message);
    this.name = 'CodexHostedWebPolicyError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function parseCodexHostedWebPolicy(raw) {
  return parseHostedWebPolicy(raw, 'AWF_CODEX_HOSTED_WEB_POLICY');
}

function hasField(value, field) {
  return Object.prototype.hasOwnProperty.call(value, field) && value[field] !== undefined;
}

function rejectUnknownFields(value, allowed, code, description) {
  if (Object.keys(value).some(field => !allowed.has(field))) {
    throw new CodexHostedWebPolicyError(code, description, 400);
  }
}

function readDomains(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_filter_invalid',
      `Codex hosted web "${field}" must be a non-empty array of domains.`,
      400,
    );
  }
  const domains = [];
  for (const entry of value) {
    const normalized = typeof entry === 'string' ? entry.trim().toLowerCase() : entry;
    if (!isValidDomain(normalized)) {
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_domain_invalid',
        `Codex hosted web "${field}" contains an invalid domain.`,
        400,
      );
    }
    if (!domains.includes(normalized)) domains.push(normalized);
  }
  return domains;
}

function resolveFilters(policy, filters) {
  if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_filter_invalid',
      'Codex hosted web "filters" must be an object.',
      400,
    );
  }
  const input = filters || {};
  rejectUnknownFields(
    input,
    FILTER_FIELDS,
    'codex_hosted_web_filter_invalid',
    'Codex hosted web filters contain an unrecognized field.',
  );
  const hasAllowed = hasField(input, 'allowed_domains');
  const hasBlocked = hasField(input, 'blocked_domains');
  const requestedAllowed = hasAllowed ? readDomains(input.allowed_domains, 'allowed_domains') : null;
  const requestedBlocked = hasBlocked ? readDomains(input.blocked_domains, 'blocked_domains') : null;
  const result = { ...input };

  if (policy.mode === 'allow') {
    const allowed = requestedAllowed ? intersectDomains(policy.domains, requestedAllowed) : policy.domains;
    if (allowed.length === 0) {
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_empty_intersection',
        'Codex hosted web allowed domains have no overlap with the AWF policy.',
      );
    }
    result.allowed_domains = allowed;
    if (requestedBlocked) result.blocked_domains = requestedBlocked;
  } else {
    result.blocked_domains = [...new Set([...policy.domains, ...(requestedBlocked || [])])];
    if (requestedAllowed) result.allowed_domains = requestedAllowed;
  }
  return result;
}

function validateAccessMode(value, field, allowedStrings = []) {
  if (value === undefined || typeof value === 'boolean') return;
  if (typeof value === 'string' && allowedStrings.includes(value)) return;
  throw new CodexHostedWebPolicyError(
    'codex_hosted_web_access_invalid',
    `Codex hosted web "${field}" has an unsupported access mode.`,
    400,
  );
}

function resolveMaxUses(policy, value) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_max_uses_invalid',
      'Codex hosted web "max_uses" must be a positive integer.',
      400,
    );
  }
  if (policy.maxUses === undefined) return value;
  return value === undefined ? policy.maxUses : Math.min(policy.maxUses, value);
}

function isRecognizedToolType(type) {
  const match = typeof type === 'string' ? WEB_SEARCH_TOOL.exec(type) : null;
  if (!match) return false;
  if (!match[1]) return true;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function enforceResponses(body, policy) {
  if (!body || !Array.isArray(body.tools)) return null;
  let matched = false;
  const tools = body.tools.map(tool => {
    const type = tool && typeof tool === 'object' ? tool.type : undefined;
    if (typeof type !== 'string' || !WEB_SEARCH_CANDIDATE.test(type)) return tool;
    matched = true;
    if (!policy.enabled) {
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_disabled',
        'Codex hosted web search is disabled by AWF policy.',
      );
    }
    if (!isRecognizedToolType(type)) {
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_tool_unrecognized',
        'Unrecognized Codex hosted web tool; AWF cannot prove the domain policy applies.',
        400,
      );
    }
    rejectUnknownFields(
      tool,
      TOOL_FIELDS,
      'codex_hosted_web_tool_unrecognized',
      'Codex hosted web tool contains an unrecognized field.',
    );
    validateAccessMode(tool.external_web_access, 'external_web_access');
    validateAccessMode(tool.indexed_web_access, 'indexed_web_access');
    const result = { ...tool, filters: resolveFilters(policy, tool.filters) };
    const maxUses = resolveMaxUses(policy, tool.max_uses);
    if (maxUses === undefined) delete result.max_uses;
    else result.max_uses = maxUses;
    return result;
  });
  return matched ? { ...body, tools } : null;
}

function hostAllowed(host, filters) {
  const allowed = filters.allowed_domains;
  if (allowed && !allowed.some(domain => domainIsWithin(host, domain))) return false;
  const blocked = filters.blocked_domains;
  return !blocked || !blocked.some(domain => domainIsWithin(host, domain));
}

function narrowQueryDomains(query, filters) {
  if (!hasField(query, 'domains')) return query;
  const requested = readDomains(query.domains, 'domains');
  let effective = filters.allowed_domains
    ? intersectDomains(filters.allowed_domains, requested)
    : requested;
  if (filters.blocked_domains) {
    effective = effective.filter(domain =>
      !filters.blocked_domains.some(blocked => domainIsWithin(domain, blocked)));
  }
  if (effective.length === 0) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_empty_query_scope',
      'A Codex hosted web query has no domains permitted by the effective policy.',
    );
  }
  return { ...query, domains: effective };
}

function checkLiteralUrl(value, filters) {
  if (typeof value !== 'string') return;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!scheme) return;
  if (scheme[1].toLowerCase() !== 'http' && scheme[1].toLowerCase() !== 'https') {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_url_invalid',
      'A Codex hosted web command contains an invalid HTTP(S) URL host.',
      400,
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_url_invalid',
      'A Codex hosted web command contains an invalid URL.',
      400,
    );
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isValidDomain(parsed.hostname.toLowerCase())) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_url_invalid',
      'A Codex hosted web command contains an invalid HTTP(S) URL host.',
      400,
    );
  }
  if (!hostAllowed(parsed.hostname.toLowerCase(), filters)) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_url_disallowed',
      'A Codex hosted web URL host is not permitted by the effective AWF policy.',
    );
  }
}

function enforceStandalone(body, policy) {
  if (!policy.enabled) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_disabled',
      'Codex standalone hosted search is disabled by AWF policy.',
    );
  }
  if (policy.maxUses !== undefined) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_max_uses_unsupported',
      'Codex standalone hosted search cannot enforce the configured maxUses limit.',
    );
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_shape_invalid',
      'Codex standalone hosted search body must be an object.',
      400,
    );
  }
  rejectUnknownFields(
    body,
    STANDALONE_FIELDS,
    'codex_hosted_web_shape_invalid',
    'Codex standalone hosted search body contains an unrecognized field.',
  );
  const settings = body.settings === undefined ? {} : body.settings;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_shape_invalid',
      'Codex standalone hosted search settings must be an object.',
      400,
    );
  }
  rejectUnknownFields(
    settings,
    SETTINGS_FIELDS,
    'codex_hosted_web_shape_invalid',
    'Codex standalone hosted search settings contain an unrecognized field.',
  );
  validateAccessMode(settings.external_web_access, 'external_web_access', ['cached', 'indexed', 'live']);
  const filters = resolveFilters(policy, settings.filters);
  const commands = body.commands === undefined ? {} : body.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) {
    throw new CodexHostedWebPolicyError(
      'codex_hosted_web_shape_invalid',
      'Codex standalone hosted search commands must be an object.',
      400,
    );
  }
  const updatedCommands = {};
  for (const [name, entries] of Object.entries(commands)) {
    if (!SEARCH_COMMANDS.has(name) || !Array.isArray(entries)) {
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_command_unrecognized',
        'Codex standalone hosted search contains an unrecognized command shape.',
        400,
      );
    }
    updatedCommands[name] = entries.map(entry => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new CodexHostedWebPolicyError(
          'codex_hosted_web_command_unrecognized',
          'Codex standalone hosted search contains an unrecognized command shape.',
          400,
        );
      }
      rejectUnknownFields(
        entry,
        COMMAND_FIELDS[name],
        'codex_hosted_web_command_unrecognized',
        'Codex standalone hosted search contains an unrecognized command field.',
      );
      if (name === 'search_query' || name === 'image_query') return narrowQueryDomains(entry, filters);
      if (URL_COMMANDS.has(name)) checkLiteralUrl(entry.ref_id, filters);
      return entry;
    });
  }
  return {
    ...body,
    commands: updatedCommands,
    settings: { ...settings, filters },
  };
}

function makeCodexHostedWebTransform(policy) {
  if (!policy) return null;
  return (bodyBuffer, req) => {
    let pathname = '';
    try {
      pathname = new URL(req?.url || '/', 'http://localhost').pathname.replace(/\/+$/, '') || '/';
    } catch {}
    const standalone = SEARCH_PATHS.has(pathname);
    let body;
    try {
      body = JSON.parse(bodyBuffer.toString('utf8'));
    } catch {
      if (!standalone) return null;
      throw new CodexHostedWebPolicyError(
        'codex_hosted_web_shape_invalid',
        'Codex standalone hosted search body must be valid JSON.',
        400,
      );
    }
    const updated = standalone ? enforceStandalone(body, policy) : enforceResponses(body, policy);
    if (updated === null) return null;
    const result = Buffer.from(JSON.stringify(updated), 'utf8');
    return result.equals(bodyBuffer) ? null : result;
  };
}

module.exports = {
  CodexHostedWebPolicyError,
  parseCodexHostedWebPolicy,
  enforceResponses,
  enforceStandalone,
  makeCodexHostedWebTransform,
};
