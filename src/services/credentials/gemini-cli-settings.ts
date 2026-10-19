import * as path from 'path';
import { WrapperConfig } from '../../types';
import { isGcpOidcConfigured } from './gcp-oidc-config';
import { getConfigEnvValue } from '../../env-utils';
import { runtimeUsesComposeAgent } from '../../container-runtime';

/** Value of `AuthType.USE_GEMINI` in the Gemini CLI (`google-gemini/gemini-cli`). */
const GEMINI_CLI_API_KEY_AUTH_TYPE = 'gemini-api-key';

/**
 * Location of the AWF-owned Gemini CLI system settings inside the agent chroot.
 * Gemini verifies root ownership and permissions of every ancestor, so this
 * cannot live below the runner-owned home.
 */
export const GEMINI_CLI_SYSTEM_SETTINGS_PATH = '/etc/awf/gemini-cli/settings.json';

/** Root-owned staging directory; only the settings file is mounted into the agent. */
export function getGeminiSystemSettingsSourcePath(workDir: string): string {
  return path.join(workDir, 'gemini-system-settings', 'settings.json');
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
 * are unaffected by the regression. Pinning API-key auth there would break them.
 * The settings file is only mounted into Compose-backed agents, so the pin is
 * likewise not injected for external runtime backends.
 */
export function shouldPinGeminiAuthType(config: WrapperConfig): boolean {
  return runtimeUsesComposeAgent(config.containerRuntime)
    && getConfigEnvValue(config, 'GOOGLE_GENAI_USE_VERTEXAI') !== 'true'
    && getConfigEnvValue(config, 'GOOGLE_GENAI_USE_GCA') !== 'true';
}

/** True when AWF routes the Gemini CLI through the api-proxy sidecar. */
export function isGeminiProxyRoutingEnabled(config: WrapperConfig): boolean {
  return Boolean(config.enableApiProxy) && (Boolean(config.geminiApiKey) || isGcpOidcConfigured(config));
}
