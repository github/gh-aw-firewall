// Matches the install step with captured indentation:
// - "Install awf binary" or "Install AWF binary" step at any indent level
// - run command invoking install_awf_binary.sh with a version
// - optional generated env block between the step name and run command
// - path may or may not be double-quoted (newer gh-aw compilers quote it)
// - the version may be followed by trailing flags (e.g. --rootless) that newer
//   gh-aw compilers append; tolerate anything up to the end of the line
export const installStepRegex =
  /^(\s*)- name: Install [Aa][Ww][Ff] binary\n(?:\1  env:\n(?:\1    [^\n]+\n)+)?\1  run: bash "?(?:\/opt\/gh-aw|\$\{RUNNER_TEMP\}\/gh-aw)\/actions\/install_awf_binary\.sh"? v[0-9.]+[^\n]*\n/m;
export const installStepRegexGlobal = new RegExp(installStepRegex.source, 'gm');
// Matches the generated ripgrep installer step with or without the timeout
// wrapper added by post-processing.
// The setup action falls back to a quiet apt-get update, which can otherwise hang
// for hours when a hosted runner's package mirror stops responding.
export const ripgrepInstallStepRegex =
  /^(\s+)- name: Install ripgrep\n(?:\1  timeout-minutes: 5\n)?\1  run: (?:timeout --foreground --kill-after=10s 4m )?bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/install_ripgrep\.sh"\n/gm;
// Matches the generated Cloud Hypervisor bundle setup step so selected smoke
// workflows can retry transient release-asset download resets. The second
// alternative intentionally matches the already-wrapped block so the patch is
// idempotent across postprocess runs. The lookahead requires a subsequent step
// because the multiline wrapped block is consumed up to the next sibling step.
export const cloudHypervisorBundleStepRegex =
  /^(\s+)- name: Download and verify cloud-hypervisor bundle\n\1  id: cloud-hypervisor-bundle\n\1  env:\n\1    GH_AW_AWF_VERSION: ([^\n]+)\n\1  run: (?:bash "\$\{RUNNER_TEMP\}\/gh-aw\/actions\/cloud_hypervisor_setup_bundle\.sh"|\|\n(?:\1    .*\n)+?(?=\1- name: ))/gm;
// Collapse duplicate "Setup Node.js" steps: buildLocalInstallSteps injects a
// Setup Node.js step but some workflows already emit an identical one immediately
// before the install step. The backreference only matches byte-identical blocks.
export const duplicateSetupNodeRegex =
  /^( {6}- name: Setup Node\.js\n {8}uses: actions\/setup-node@[0-9a-f]+ # v[0-9.]+\n {8}with:\n {10}node-version: '[^']*'\n {10}package-manager-cache: false\n)\1/m;
// Remove sparse-checkout from the agent job's checkout step so the full repo
// is available for npm ci / npm run build. The compiler generates sparse-checkout
// for .github and .agents only, but we need src/, package.json, tsconfig.json etc.
// Match the sparse-checkout block (key + indented content lines) and the depth line.
export const sparseCheckoutRegex = /^(\s+)sparse-checkout: \|\n(?:\1  .+\n)+/gm;
export const shallowDepthRegex = /^(\s+)depth: 1\n/gm;
// Replace --image-tag <version> --skip-pull with --build-local so smoke tests
// use locally-built container images instead of pre-built GHCR images.
export const imageTagRegex = /--image-tag\s+[0-9.]+\s+--skip-pull/g;
// When no --image-tag is present, the compiler still emits --skip-pull alone.
// Replace standalone --skip-pull with --build-local.
export const standaloneSkipPullRegex = /--skip-pull(?:\s+--build-local)?/g;
export const localAwfImageDownloadRegex =
  /\s+ghcr\.io\/github\/gh-aw-firewall\/(?:agent|api-proxy|squid|enclave-(?:agent|mcp-server)):[0-9.]+(?:@sha256:[a-f0-9]{64})?/g;

export function assertCloudHypervisorSmokePrimaryRuntime(content: string): string {
  if (
    !content.includes('--container-runtime cloud-hypervisor')
    || content.includes('--container-runtime docker')
  ) {
    throw new Error('Cloud Hypervisor enclave smoke must select the Cloud Hypervisor primary runtime');
  }
  return content;
}

const cloudHypervisorDigestArgs =
  ' --cloud-hypervisor-binary-sha256 "$(jq -er \'.artifacts.cloudHypervisor.sha256\' "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST}")"' +
  ' --cloud-hypervisor-virtiofsd-sha256 "$(jq -er \'.artifacts.virtiofsd.sha256\' "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST}")"' +
  ' --cloud-hypervisor-kernel-sha256 "$(jq -er \'.artifacts.kernel.sha256\' "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST}")"' +
  ' --cloud-hypervisor-rootfs-sha256 "$(jq -er \'.artifacts.rootfs.sha256\' "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST}")"' +
  ' --cloud-hypervisor-supervisor-sha256 "$(jq -er \'.artifacts.supervisor.sha256\' "${GH_AW_CLOUD_HYPERVISOR_ARTIFACT_MANIFEST}")"';

export function patchLocalBuildCloudHypervisorArtifacts(content: string): string {
  let patched = content;
  if (!patched.includes('--cloud-hypervisor-mount-policy workspace-and-tool-cache')) {
    patched = patched.replace(
      '--cloud-hypervisor-preview ',
      '--cloud-hypervisor-preview --cloud-hypervisor-mount-policy workspace-and-tool-cache ',
    );
  }
  if (!patched.includes('--cloud-hypervisor-development-allow-unattested-artifacts')) {
    patched = patched.replace(
      '--cloud-hypervisor-preview ',
      '--cloud-hypervisor-preview --cloud-hypervisor-development-allow-unattested-artifacts ',
    );
  }
  if (!patched.includes('--cloud-hypervisor-binary-sha256')) {
    patched = patched.replace(
      ' --cloud-hypervisor-supervisor "${GH_AW_CLOUD_HYPERVISOR_SUPERVISOR}"',
      ' --cloud-hypervisor-supervisor "${GH_AW_CLOUD_HYPERVISOR_SUPERVISOR}"' +
        cloudHypervisorDigestArgs,
    );
  }
  if (!patched.includes('AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS: "1"')) {
    patched = patched.replace(
      '        env:\n          AWF_REFLECT_ENABLED: 1\n',
      '        env:\n' +
        '          AWF_CLOUD_HYPERVISOR_DEVELOPMENT_ALLOW_UNATTESTED_ARTIFACTS: "1"\n' +
        '          AWF_REFLECT_ENABLED: 1\n',
    );
  }
  return patched;
}
