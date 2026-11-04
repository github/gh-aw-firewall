import execa from 'execa';
import type { WrapperConfig } from './types';
import { AGENT_CONTAINER_NAME } from './constants';
import { getLocalDockerEnv } from './docker-host';
import { shellSingleQuote } from './cloud-hypervisor/backend-utils';
import {
  MAX_PROBE_BYTES, selectHarness,
  type HarnessContext, type HarnessProbe,
} from './model-information-contract/harness-observation';

const CONTROL_DIR = '/run/awf-harness';
const PROBE_DIR = `${CONTROL_DIR}/probe`;
const READY_TIMEOUT_SECONDS = 120;
export const DOCKER_HARNESS_ENVIRONMENT_LABEL = 'io.github.awf.harness-environment';

export function supportsDockerHarnessObservation(config: WrapperConfig): boolean {
  return (!config.containerRuntime || ['docker', 'runc'].includes(config.containerRuntime)) &&
    selectHarness(config.agentCommand) !== undefined;
}

/**
 * Runs in the entrypoint's final command shell, after chroot, identity, cwd and
 * PATH setup. Container-local tmpfs avoids runner/daemon bind-mount ambiguity.
 */
export function withDockerHarnessObservation(
  config: WrapperConfig, context: HarnessContext, command: string,
): string {
  if (!supportsDockerHarnessObservation(config)) return command;
  const selection = selectHarness(config.agentCommand)!;
  // Avoid sourcing BASH_ENV a second time in the probe launcher, but restore
  // its exported value for the executable itself (including script harnesses).
  const probe = `if [ "$1" = x ]; then export BASH_ENV="$2"; else unset BASH_ENV; fi; ` +
    `p=$3; test -f "$p" && test -x "$p" || exit 126; ` +
    `( printf '%s\\n' "$p"; "$p" --version ) | /usr/bin/head -c ${MAX_PROBE_BYTES + 1}; ` +
    `exit \${PIPESTATUS[0]}`;
  const selectedBinary = shellSingleQuote(selection.binary);
  return `(
umask 077
target_type=$(type -t -- ${selectedBinary} 2>/dev/null) || target_type=
resolved=
if [ "$target_type" = file ]; then
  resolved=$(command -v -- ${selectedBinary} 2>/dev/null) || resolved=
fi
if [ -n "$resolved" ] && [ -f "$resolved" ] && [ -x "$resolved" ]; then
  if /usr/bin/timeout --signal=TERM --kill-after=1s 10s /usr/bin/env -u BASH_ENV /bin/bash --noprofile --norc -c ${shellSingleQuote(probe)} awf-harness "$(/usr/bin/printenv BASH_ENV >/dev/null && printf x)" "\${BASH_ENV-}" "$resolved" >${PROBE_DIR}/stdout 2>/dev/null; then
    status=0
  else
    status=$?
  fi
else
  : >${PROBE_DIR}/stdout
  if [ "$target_type" = file ] || [ -z "$target_type" ]; then
    status=127
  else
    status=126
  fi
fi
cd ${shellSingleQuote(PROBE_DIR)} || exit 125
printf '%s\\n%s\\n' ${shellSingleQuote(context.environment)} "$status" >result.tmp || exit 125
/bin/cat stdout >>result.tmp || exit 125
/bin/mv result.tmp result || exit 125
for ((n=0; n<${READY_TIMEOUT_SECONDS * 10}; n++)); do
  if [ -f ../allow ]; then
    IFS= read -r decision <../allow
    if [ "$decision" != ${shellSingleQuote(context.environment)} ]; then
      printf '%s\\n' 'AWF harness observation release invalid; command not started.' >&2
      exit 125
    fi
    exit 0
  fi
  /bin/sleep 0.1
done
printf '%s\\n' 'AWF harness observation release timed out; command not started.' >&2
exit 125
) || exit 125
${command}`;
}

// Neither path is host-mounted or available to the API proxy. Both execution
// modes use the same command-visible path; Docker exec stays outside chroot.
export function dockerHarnessTmpfs(uid: string, gid: string): string[] {
  return ['', '/host'].flatMap(prefix => [
    `${prefix}${CONTROL_DIR}:rw,noexec,nosuid,nodev,size=64k,mode=0711,uid=0,gid=0`,
    `${prefix}${PROBE_DIR}:rw,noexec,nosuid,nodev,size=64k,mode=0700,uid=${uid},gid=${gid}`,
  ]);
}

export function createDockerHarnessObservation(config: WrapperConfig, context: HarnessContext): {
  probeHarness: HarnessProbe;
  releaseHarness: () => Promise<void>;
} | undefined {
  if (!supportsDockerHarnessObservation(config)) return undefined;
  let ready = false;
  const locate = `if [ "$AWF_CHROOT_ENABLED" = true ]; then cd /host${CONTROL_DIR}; else cd ${CONTROL_DIR}; fi`;
  const probeHarness: HarnessProbe = async () => {
    const script = `${locate} || exit 125
for ((n=0; n<${READY_TIMEOUT_SECONDS * 10}; n++)); do
  if [ -f probe/result ]; then /usr/bin/head -c ${MAX_PROBE_BYTES + 257} probe/result; exit; fi
  /bin/sleep 0.1
done
exit 124`;
    const result = await execa('docker', [
      'exec', '--user', '0:0', AGENT_CONTAINER_NAME,
      '/bin/bash', '--noprofile', '--norc', '-p', '-c', script,
    ], {
      env: getLocalDockerEnv(), timeout: (READY_TIMEOUT_SECONDS + 5) * 1000,
      maxBuffer: MAX_PROBE_BYTES + 512, stderr: 'ignore', reject: false, stripFinalNewline: false,
    });
    const [environment, status, ...output] = result.stdout.split('\n');
    if (result.exitCode !== 0 || environment !== context.environment || !/^\d{1,3}$/.test(status)) {
      throw new Error('Docker harness observation readiness failed; command not started.');
    }
    ready = true;
    const stdout = output.join('\n');
    const exitCode = Number(status);
    return {
      stdout, exitCode, timedOut: exitCode === 124 || exitCode === 137,
      overflow: Buffer.byteLength(stdout) > MAX_PROBE_BYTES,
    };
  };
  const releaseHarness = async (): Promise<void> => {
    if (!ready) {
      // An entrypoint/preflight failure can exit before reaching the gate.
      // Let the existing lifecycle collect its logs and original exit status,
      // but never release a running or differently bound container.
      try {
        const format = `{{.State.Running}} {{index .Config.Labels "${DOCKER_HARNESS_ENVIRONMENT_LABEL}"}}`;
        const state = await execa('docker', [
          'inspect', '--format', format, AGENT_CONTAINER_NAME,
        ], {
          env: getLocalDockerEnv(), timeout: 5000, maxBuffer: 512, stderr: 'ignore', reject: false,
        });
        if (state.exitCode === 0 && state.stdout.trim() === `false ${context.environment}`) return;
      } catch {
        // No trusted exited-container state: keep the pre-command gate closed.
      }
      throw new Error('Docker harness observation is not ready; command not started.');
    }
    const script = `${locate} || exit 125
IFS= read -r environment <probe/result || exit 125
[ "$environment" = "$1" ] || exit 125
umask 077
printf '%s\\n' "$1" >allow.tmp && /bin/chmod 0444 allow.tmp && /bin/mv allow.tmp allow`;
    try {
      const result = await execa('docker', [
        'exec', '--user', '0:0', AGENT_CONTAINER_NAME,
        '/bin/bash', '--noprofile', '--norc', '-p', '-c', script, 'awf-harness', context.environment,
      ], {
        env: getLocalDockerEnv(), timeout: 5000, stderr: 'ignore', reject: false,
      });
      if (result.exitCode !== 0) throw new Error('release failed');
    } catch {
      throw new Error('Docker harness observation release failed; command not started.');
    }
    ready = false;
  };
  return { probeHarness, releaseHarness };
}
