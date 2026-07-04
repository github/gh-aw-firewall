// Applies Codex-specific transformations to OpenAI/Codex workflow lock files.
// These transforms must NOT be applied to Claude, Copilot, or other non-OpenAI
// workflows.
//
// Returns the (possibly modified) content and a list of log messages; callers
// are responsible for writing the file and printing the messages.

import {
  codexConfigTomlHeredocRegex,
  CODEX_PROXY_PROVIDER_SENTINEL,
  CODEX_PROXY_ENV_KEY_REGEX,
  xpiaCatRegex,
  xpiaSafeBlockRegex,
} from './workflow-patch-patterns';
import { buildXpiaHeredoc } from './workflow-step-builders';

export interface CodexPatchResult {
  content: string;
  log: string[];
}

// Applies all Codex-specific transforms to a single workflow lock file.
export function applyCodexWorkflowPatches(content: string): CodexPatchResult {
  const log: string[] = [];

  // Inject a custom "openai-proxy" provider into the Codex config.toml heredoc.
  // This disables WebSocket transport and routes REST API calls through the AWF
  // api-proxy sidecar (at 172.30.0.30:10000), which injects the real OpenAI key.
  //
  // Codex v0.121+ ignores OPENAI_BASE_URL env var when constructing WebSocket URLs
  // for the responses API (wss://api.openai.com/v1/responses), connecting directly
  // to OpenAI and sending the api-proxy placeholder key → 401 Unauthorized.
  //
  // The built-in "openai" provider ID is reserved and cannot be overridden via
  // [model_providers.openai] (Codex will reject the config). Instead we define a
  // custom provider "openai-proxy" that:
  //   - points to the AWF api-proxy sidecar at http://172.30.0.30:10000
  //   - sets supports_websockets=false to force REST (which respects base_url)
  //   - omits env_key so Codex does not hard-require OPENAI_API_KEY at startup;
  //     auth is handled by the sidecar
  if (!content.includes(CODEX_PROXY_PROVIDER_SENTINEL)) {
    const heredocMatch = content.match(codexConfigTomlHeredocRegex);
    if (heredocMatch) {
      const indent = heredocMatch[1];
      const modelProvidersBlock =
        `${indent}model_provider = "openai-proxy"\n` +
        `${indent}\n` +
        `${indent}[model_providers.openai-proxy]\n` +
        `${indent}name = "OpenAI AWF proxy"\n` +
        `${indent}base_url = "http://172.30.0.30:10000"\n` +
        `${indent}supports_websockets = false\n` +
        `${indent}\n`;
      content = content.replace(
        codexConfigTomlHeredocRegex,
        `$1$2${modelProvidersBlock}$3`
      );
      log.push(`  Injected openai-proxy custom provider into Codex config.toml heredoc`);
    } else {
      log.push(
        `  WARNING: Could not find Codex config.toml heredoc pattern to inject model_providers config. ` +
          `The compiled lock file may have changed structure. Manual review required.`
      );
    }
  } else {
    log.push(`  openai-proxy custom provider already present in Codex config.toml`);
  }

  // Remove legacy env_key for openai-proxy so Codex doesn't require OPENAI_API_KEY
  // in the sandbox when auth is provided by the sidecar. The cheap includes()
  // guard skips the regex entirely when there is no env_key line to strip, which
  // is the common case on already-processed lock files.
  if (
    content.includes('env_key = "OPENAI_API_KEY"') &&
    CODEX_PROXY_ENV_KEY_REGEX.test(content)
  ) {
    content = content.replace(CODEX_PROXY_ENV_KEY_REGEX, '$1');
    log.push('  Removed legacy env_key from openai-proxy provider');
  }

  // Replace xpia.md cat command with safe inline security policy (first run).
  const xpiaMatch = content.match(xpiaCatRegex);
  if (xpiaMatch) {
    const indent = xpiaMatch[1];
    const appendSuffix = xpiaMatch[2] ?? '';
    content = content.replace(xpiaCatRegex, buildXpiaHeredoc(indent, appendSuffix));
    log.push(`  Replaced xpia.md cat with safe inline security policy`);
  }

  // Update an already-replaced GH_AW_XPIA_SAFE_EOF block (idempotent re-run).
  // This handles the case where SAFE_XPIA_CONTENT is updated after the initial
  // replacement was applied, without requiring a full recompile from .md source.
  const safeBlockMatch = !xpiaMatch && content.match(xpiaSafeBlockRegex);
  if (safeBlockMatch) {
    const indent = safeBlockMatch[1];
    const appendSuffix = safeBlockMatch[2] ?? '';
    content = content.replace(xpiaSafeBlockRegex, buildXpiaHeredoc(indent, appendSuffix));
    log.push(`  Updated existing inline security policy`);
  }

  return { content, log };
}
