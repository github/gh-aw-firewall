import * as path from 'path';
import { WrapperConfig } from '../../types';
import { isGcpOidcConfigured } from './gcp-oidc-config';

/** Value of `AuthType.USE_GEMINI` in the Gemini CLI (`google-gemini/gemini-cli`). */
const GEMINI_CLI_API_KEY_AUTH_TYPE = 'gemini-api-key';

/**
 * Location of the AWF-owned Gemini CLI *system* settings file, relative to the
 * agent's home directory. It lives in the empty chroot home volume, so AWF never
 * writes into the host's real `~/.gemini` directory.
 */
export const GEMINI_CLI_SYSTEM_SETTINGS_RELATIVE_PATH = path.join('.awf', 'gemini-cli-system-settings.json');

/** Absolute path of the system settings file as seen by the agent. */
export function getGeminiSystemSettingsPath(home: string): string {
  return path.join(home, GEMINI_CLI_SYSTEM_SETTINGS_RELATIVE_PATH);
}

/**
 * Contents of the AWF-owned Gemini CLI system settings file.
 *
 * Gemini CLI >= 0.44 resolves a non-empty `GOOGLE_GEMINI_BASE_URL` to
 * `AuthType.GATEWAY` in `getAuthTypeFromEnv()`, but `validateAuthMethod()` has no
 * branch for GATEWAY and aborts the run with `Invalid auth method selected.`
 * (exit code 41 — see google-gemini/gemini-cli#27550). AWF must set
 * `GOOGLE_GEMINI_BASE_URL` to route the CLI through the api-proxy sidecar, so the
 * auth type is pinned explicitly instead: the CLI uses
 * `settings.merged.security.auth.selectedType || getAuthTypeFromEnv()`, and the
 * system settings scope has the highest merge precedence. `GOOGLE_GEMINI_BASE_URL`
 * is still honoured for request routing under `gemini-api-key` auth.
 */
export function buildGeminiSystemSettingsContent(): string {
  const settings = { security: { auth: { selectedType: GEMINI_CLI_API_KEY_AUTH_TYPE } } };
  return `${JSON.stringify(settings, null, 2)}\n`;
}

/**
 * Vertex AI (`GOOGLE_GENAI_USE_VERTEXAI`) and Google-account (`GOOGLE_GENAI_USE_GCA`)
 * auth are resolved *before* the GATEWAY branch in the Gemini CLI, so those runs
 * are unaffected by the regression. Pinning API-key auth there would break them,
 * so the settings file is not written and `GEMINI_CLI_SYSTEM_SETTINGS_PATH` is
 * not injected.
 */
export function shouldPinGeminiAuthType(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GOOGLE_GENAI_USE_VERTEXAI !== 'true' && env.GOOGLE_GENAI_USE_GCA !== 'true';
}

/** True when AWF routes the Gemini CLI through the api-proxy sidecar. */
export function isGeminiProxyRoutingEnabled(config: WrapperConfig): boolean {
  return Boolean(config.enableApiProxy) && (Boolean(config.geminiApiKey) || isGcpOidcConfigured(config));
}
