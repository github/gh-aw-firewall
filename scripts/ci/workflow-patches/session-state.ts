import type { TransformResult } from './types';

// Inject --session-state-dir into AWF invocations so Copilot CLI session-state
// (events.jsonl) is written to a predictable host path that artifact upload can
// read. A global regex is used because some lock files contain two agent jobs.
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
export const legacyApiProxyLogsDirRegex =
  /\/tmp\/gh-aw\/sandbox\/firewall\/logs\/api-proxy(?!-logs)/g;

export function collectSessionState(content: string): TransformResult {
  const messages: string[] = [];
  sessionStateDirInjectionRegex.lastIndex = 0;
  const sessionStateDirMatches = content.match(sessionStateDirInjectionRegex);
  if (sessionStateDirMatches) {
    content = content.replace(
      sessionStateDirInjectionRegex,
      `--audit-dir /tmp/gh-aw/sandbox/firewall/audit --session-state-dir ${SESSION_STATE_DIR}`
    );
    messages.push(
      `  Injected --session-state-dir in ${sessionStateDirMatches.length} awf invocation(s)`
    );
  }
  sessionStateDirConfigInjectionRegex.lastIndex = 0;
  const sessionStateDirConfigMatches = content.match(sessionStateDirConfigInjectionRegex);
  if (sessionStateDirConfigMatches) {
    content = content.replace(
      sessionStateDirConfigInjectionRegex,
      (match) => `${match} --session-state-dir ${SESSION_STATE_DIR}`
    );
    messages.push(
      `  Injected --session-state-dir in ${sessionStateDirConfigMatches.length} awf --config invocation(s)`
    );
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
