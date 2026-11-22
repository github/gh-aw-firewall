/* global require, module, Buffer */
/* eslint-disable @typescript-eslint/no-require-imports */
const { check, object, MAX_STREAM_BYTES } = require('./common.cjs');

const AUTH_FIELDS = {
  credential_source: ['github_token', 'provider_api_key', 'none'],
  credential_kind: ['none', 'placeholder', 'fine_grained_pat', 'classic_pat', 'oauth', 'user_token', 'installation_token', 'other'],
  credential_shape: ['missing', 'placeholder', 'embedded_whitespace', 'prefixed', 'whitespace', 'clean'],
  target_source: ['explicit', 'server', 'default'],
  server_kind: ['missing', 'invalid', 'github', 'ghec', 'ghes'],
  base_path: ['configured', 'none'],
  integration_source: ['copilot_integration_id', 'github_copilot_integration_id', 'default'],
  authorization_match: ['yes', 'no'],
  integration_match: ['yes', 'no'],
  target: ['standard', 'enterprise', 'business', 'ghec', 'custom'],
  target_match: ['yes', 'no'],
  method: ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'other'],
  endpoint: ['models', 'models_session', 'auto', 'chat_completions', 'responses', 'other'],
  authorization: ['missing', 'multiple', 'malformed', 'bearer', 'token', 'other'],
  integration: ['missing', 'multiple', 'workflows', 'cli', 'custom'],
  error_class: ['none', 'expired', 'invalid_credential', 'insufficient_scope', 'entitlement', 'integration', 'malformed_auth', 'unclassified', 'uninspectable'],
  body_capture: ['complete', 'omitted', 'truncated', 'not_required'],
  challenge: ['missing', 'invalid_token', 'insufficient_scope', 'other', 'not_required'],
};

function isSafeCopilotAuthLogFields(value) {
  if (!value || value.length > 1024) return false;
  const entries = value.split(' ').map(field => field.split('='));
  if (entries.some(pair => pair.length !== 2)) return false;
  return Object.entries(AUTH_FIELDS).map(([name, allowed]) => {
    const pair = entries.find(([key]) => key === name);
    const candidate = pair?.[1];
    const safe = typeof candidate === 'string' && allowed.includes(candidate) ? candidate : 'unknown';
    return `${name}=${safe}`;
  }).join(' ') === value;
}

function redactCredentials(bytes) {
  const redactText = text => text
    .replace(/\b((?:proxy-)?authorization\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/\bbearer\s+[^\r\n]+/gi, '[REDACTED]')
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)\b/g, '[REDACTED]');
  const redactValue = (value, depth = 0) => {
    check(depth <= 64, 'credential-redaction-bound', 'oversized');
    if (typeof value === 'string') {
      let embedded;
      try {
        embedded = JSON.parse(value);
      } catch { return redactText(value); }
      if (object(embedded) || Array.isArray(embedded)) {
        const sanitized = redactValue(embedded, depth + 1);
        return JSON.stringify(sanitized) === JSON.stringify(embedded) ? value : JSON.stringify(sanitized);
      }
      return redactText(value);
    }
    if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      redactText(key), /^(?:proxy-)?authorization$/i.test(key) ? '[REDACTED]' : redactValue(item, depth + 1),
    ]));
    return value;
  };
  // Preserve every approved retained field. Decode JSON only for credential
  // redaction, so an auth line inside a raw stream cannot consume its JSON tail.
  const redacted = Buffer.from(bytes.toString('utf8').split('\n').map(line => {
    let value;
    try { value = JSON.parse(line); } catch { return redactText(line); }
    const sanitized = redactValue(value);
    return JSON.stringify(sanitized) === JSON.stringify(value) ? line : JSON.stringify(sanitized);
  }).join('\n'));
  check(redacted.length <= MAX_STREAM_BYTES, 'stream-bound');
  return redacted;
}

module.exports = { redactCredentials, isSafeCopilotAuthLogFields };
