const FIELDS: Record<string, readonly string[]> = {
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

/** Reconstruct a finite vocabulary, never redacted provider text or header values. */
export function projectCopilotAuthLogFields(value: Record<string, unknown>): string {
  return Object.entries(FIELDS).map(([name, allowed]) => {
    const candidate = value[name];
    const safe = typeof candidate === 'string' && allowed.includes(candidate) ? candidate : 'unknown';
    return `${name}=${safe}`;
  }).join(' ');
}

export function isSafeCopilotAuthLogFields(value: string | undefined): boolean {
  if (!value || value.length > 1024) return false;
  const entries = value.split(' ').map(field => field.split('='));
  if (entries.some(pair => pair.length !== 2)) return false;
  return projectCopilotAuthLogFields(Object.fromEntries(entries)) === value;
}
