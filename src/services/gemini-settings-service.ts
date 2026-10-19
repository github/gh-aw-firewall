import {
  buildGeminiSystemSettingsContent,
  GEMINI_CLI_SYSTEM_SETTINGS_DIRECTORY,
} from './credentials/gemini-cli-settings';
import type { DockerComposeConfig } from '../types';

export const GEMINI_SETTINGS_VOLUME = 'gemini-system-settings';
export const GEMINI_SETTINGS_SERVICE = 'gemini-settings-init';
export const GEMINI_SETTINGS_MOUNT = `${GEMINI_SETTINGS_VOLUME}:/host${GEMINI_CLI_SYSTEM_SETTINGS_DIRECTORY}:ro`;

/**
 * Stage non-secret system policy in the daemon's filesystem, not the runner's
 * writable home. Using the agent image also supports split-filesystem DinD
 * without another image or a new agent-entrypoint requirement.
 */
export function buildGeminiSettingsService(
  agentService: Pick<DockerComposeConfig['services'][string], 'image' | 'build'>,
) {
  if (!agentService.image && !agentService.build) {
    throw new Error('Gemini settings initializer requires the agent image or build configuration');
  }
  return {
    ...(agentService.image ? { image: agentService.image } : { build: agentService.build }),
    user: '0:0',
    network_mode: 'none',
    volumes: [`${GEMINI_SETTINGS_VOLUME}:/settings:rw`],
    entrypoint: ['/bin/sh', '-c'],
    command: [
      'set -eu; ' +
      'chown 0:0 /settings; chmod 0755 /settings; ' +
      // Never follow a stale symlink, FIFO or hardlink when reusing a volume.
      'if [ -L /settings/settings.json ] || ' +
      '{ [ -e /settings/settings.json ] && ' +
      '{ [ ! -f /settings/settings.json ] || [ "$$(stat -c %h /settings/settings.json)" != 1 ]; }; }; then ' +
      'echo "Refusing unsafe Gemini system settings file" >&2; exit 1; fi; ' +
      'umask 022; ' +
      `printf '%s' '${buildGeminiSystemSettingsContent()}' > /settings/settings.json; ` +
      'chown 0:0 /settings/settings.json; chmod 0644 /settings/settings.json',
    ],
    restart: 'no',
    read_only: true,
    security_opt: ['no-new-privileges:true'],
    cap_drop: ['ALL'],
    cap_add: ['CHOWN', 'FOWNER', 'DAC_OVERRIDE'],
  };
}
