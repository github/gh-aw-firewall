import type { TransformResult } from './types';

// Inject --session-state-dir into AWF invocations only when explicitly opted in,
// so Copilot CLI session-state (events.jsonl) is not persisted/uploaded by default.
// A global regex is used because some lock files contain two agent jobs.
//
// Two invocation shapes are supported:
//   1. Legacy: logging directories passed as CLI flags (`--audit-dir ...`).
//   2. Current: logging directories passed via the generated awf-config.json
//      (`awf --config "${RUNNER_TEMP}/gh-aw/awf-config.json" ...`). gh-aw moved
//      auditDir into `logging.auditDir` there, which silently broke the legacy
//      pattern and left the Copilot step summary without a conversation.
export const sessionStateDirInjectionRegex =
  /--audit-dir \/tmp\/gh-aw\/sandbox\/firewall\/audit(?! --session-state-dir)/g;
export const sessionStateDirConfigInjectionRegex =
  /awf --config "\$\{RUNNER_TEMP\}\/gh-aw\/awf-config\.json"(?! --session-state-dir)/g;
export const SESSION_STATE_DIR = '/tmp/gh-aw/sandbox/agent/session-state';
export const ENABLE_SESSION_STATE_ARTIFACTS_ENV = 'ENABLE_COPILOT_SESSION_STATE_ARTIFACTS';
export const legacyApiProxyLogsDirRegex =
  /\/tmp\/gh-aw\/sandbox\/firewall\/logs\/api-proxy(?!-logs)/g;

function isSessionStateArtifactsEnabled(): boolean {
  const value = process.env[ENABLE_SESSION_STATE_ARTIFACTS_ENV];
  return value === '1' || value === 'true';
}

export function collectSessionState(content: string): TransformResult {
  const messages: string[] = [];
  const allowSessionStateInjection = isSessionStateArtifactsEnabled();
  sessionStateDirInjectionRegex.lastIndex = 0;
  const sessionStateDirMatches = content.match(sessionStateDirInjectionRegex);
  if (sessionStateDirMatches) {
    if (allowSessionStateInjection) {
      content = content.replace(
        sessionStateDirInjectionRegex,
        `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
      );
      messages.push(
        `  Injected --session-state-dir in ${sessionStateDirMatches.length} awf invocation(s)`
      );
    } else {
      messages.push(
        `  Skipped --session-state-dir injection for ${sessionStateDirMatches.length} awf invocation(s); set ${ENABLE_SESSION_STATE_ARTIFACTS_ENV}=true to opt in`
      );
    }
  }
  sessionStateDirConfigInjectionRegex.lastIndex = 0;
  const sessionStateDirConfigMatches = content.match(sessionStateDirConfigInjectionRegex);
  if (sessionStateDirConfigMatches) {
    if (allowSessionStateInjection) {
      content = content.replace(
        sessionStateDirConfigInjectionRegex,
        (match) => `${match} --session-state-dir ${SESSION_STATE_DIR}`
      );
      messages.push(
        `  Injected --session-state-dir in ${sessionStateDirConfigMatches.length} awf --config invocation(s)`
      );
    } else {
      messages.push(
        `  Skipped --session-state-dir injection for ${sessionStateDirConfigMatches.length} awf --config invocation(s); set ${ENABLE_SESSION_STATE_ARTIFACTS_ENV}=true to opt in`
      );
    }
  }
  if (!sessionStateDirMatches && !sessionStateDirConfigMatches) {
    if (content.includes(`--session-state-dir ${SESSION_STATE_DIR}`)) {
      messages.push(`  --session-state-dir already present`);
    } else if (content.includes('awf --config') || content.includes('--audit-dir')) {
      messages.push(
        `  WARNING: awf invocation found but --session-state-dir could not be injected; ` +
          `the Copilot step summary will render an empty conversation`
      );
    }
  }
  const legacyApiProxyLogDirMatches = content.match(legacyApiProxyLogsDirRegex);
  if (legacyApiProxyLogDirMatches) {
    content = content.replace(
      legacyApiProxyLogsDirRegex,
      '/tmp/gh-aw/sandbox/firewall/logs/api-proxy-logs'
    );
    messages.push(
      `  Updated ${legacyApiProxyLogDirMatches.length} legacy api-proxy log path reference(s)`
    );
  }
  return { content, messages };
}
