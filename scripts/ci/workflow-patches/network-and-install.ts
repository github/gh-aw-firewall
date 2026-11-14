import type { PatchContext, TransformResult } from './types';
import {
  installStepRegexGlobal, duplicateSetupNodeRegex, sparseCheckoutRegex,
  shallowDepthRegex, imageTagRegex, standaloneSkipPullRegex,
  localAwfImageDownloadRegex, ripgrepInstallStepRegex,
  cloudHypervisorBundleStepRegex, patchLocalBuildCloudHypervisorArtifacts,
} from './network-and-install-patterns';
import { buildLocalInstallSteps } from '../workflow-step-builders';

const publishedAwfWorkflowLockFiles = new Set([
  // Cloud Hypervisor enclave smokes keep binaries and attested VM artifacts release-matched.
  'smoke-enclave-cloud-hypervisor.lock.yml',
  'smoke-enclave-cloud-hypervisor-copilot.lock.yml',
  'auth-doctor-updater.lock.yml',
  'runtime-enclave-doctor-updater.lock.yml',
  'network-doctor-updater.lock.yml',
  'ci-integration-doctor-updater.lock.yml',
  'daily-agent-runtime-triage.lock.yml',
  'doc-maintainer.lock.yml',
  'firewall-issue-dispatcher.lock.yml',
  'model-api-mapping-updater.lock.yml',
  'pr-sous-chef.lock.yml',
  'refactoring-scanner.lock.yml',
  'mount-docs-maintainer.lock.yml',
  'schema-sync.lock.yml',
  'self-hosted-runner-doctor-updater.lock.yml',
  'test-quality-improver.lock.yml',
  'update-release-notes.lock.yml',
]);

const cloudHypervisorBundleRetryWorkflowLockFiles = new Set([
  'smoke-cloud-hypervisor.lock.yml',
]);
const preparedSmokeImageArgs =
  '--image-registry awf-smoke --image-tag "${AWF_SMOKE_IMAGE_TAG:?}" --skip-pull';
const routingPreparedSmokeImageArgs =
  '--image-registry awf-smoke --image-tag "${AWF_SMOKE_IMAGE_TAG:?}" ' +
  '$(if [ "${GH_AW_MODEL_ROUTING:-0}" != "1" ]; then printf %s --skip-pull; fi)';

export function usesPublishedAwfRelease(workflowPath: string): boolean {
  const workflowFile = workflowPath.split(/[/\\]/).pop();
  return workflowFile !== undefined && publishedAwfWorkflowLockFiles.has(workflowFile);
}

function usesPreparedSmokeImages(content: string, workflowPath: string): boolean {
  return /(?:^|[/\\])smoke-(?:claude|copilot(?:-byok|-network-isolation)?|otel-tracing|services)\.lock\.yml$/.test(workflowPath)
    && content.includes('- name: Build local AWF smoke images\n');
}

export function configureNpmFeed(content: string): TransformResult {
  const messages: string[] = [];
  const npmRegistry = 'https://packagefeedproxy.microsoft.io/npm/';
  if (/^env:\s*$/m.test(content) && !/^ {2}NPM_CONFIG_REGISTRY:/m.test(content)) {
    content = content.replace(/^env:\s*$/m, `env:\n  NPM_CONFIG_REGISTRY: ${npmRegistry}`);
    messages.push('  Configured the Microsoft-approved npm feed for all jobs');
  }
  // Permit the approved feed only where npm downloads were already allowed.
  content = content.replace(/(\\"allowDomains\\":\[)([^\]]*)(\])/g, (match, start: string, domains: string, end: string) => {
    const allowedDomains = JSON.parse(`[${domains.replace(/\\"/g, '"')}]`) as string[];
    const hasNpmRegistry = allowedDomains.some(domain => domain === 'registry.npmjs.org');
    const hasApprovedProxy = allowedDomains.some(domain => domain === 'packagefeedproxy.microsoft.io');
    if (!hasNpmRegistry || hasApprovedProxy) return match;
    return `${start}\\"packagefeedproxy.microsoft.io\\",${domains}${end}`;
  });
  return { content, messages };
}

export function normalizePreparedImages(content: string, { workflowPath }: PatchContext): TransformResult {
  // Normalize our prior output before the shared local-build transforms for idempotency.
  if (usesPreparedSmokeImages(content, workflowPath)) {
    content = content.split(routingPreparedSmokeImageArgs).join('--build-local');
    content = content.split(JSON.stringify(routingPreparedSmokeImageArgs).slice(1, -1)).join('--build-local');
    content = content.split(preparedSmokeImageArgs).join('--build-local');
    content = content.split(JSON.stringify(preparedSmokeImageArgs).slice(1, -1)).join('--build-local');
  }
  return { content, messages: [] };
}

export function boundRipgrepInstall(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const shouldBoundRipgrepInstall =
    /(?:^|[/\\])smoke-[^/\\]+\.lock\.yml$/.test(workflowPath) ||
    workflowPath.endsWith('build-test.lock.yml');
  if (shouldBoundRipgrepInstall) {
    ripgrepInstallStepRegex.lastIndex = 0;
    const ripgrepInstallMatches = content.match(ripgrepInstallStepRegex);
    if (ripgrepInstallMatches) {
      content = content.replace(
        ripgrepInstallStepRegex,
        (_match, indent: string) =>
          `${indent}- name: Install ripgrep\n` +
          `${indent}  timeout-minutes: 5\n` +
          `${indent}  run: timeout --foreground --kill-after=10s 4m bash "\${RUNNER_TEMP}/gh-aw/actions/install_ripgrep.sh"\n`
      );
      messages.push(`  Bounded ${ripgrepInstallMatches.length} ripgrep install step(s)`);
    }
  }
  return { content, messages };
}

export function retryCloudHypervisorBundle(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  const shouldRetryCloudHypervisorBundle =
    workflowFile !== undefined &&
    cloudHypervisorBundleRetryWorkflowLockFiles.has(workflowFile);
  if (shouldRetryCloudHypervisorBundle) {
    cloudHypervisorBundleStepRegex.lastIndex = 0;
    const cloudHypervisorBundleMatches = content.match(cloudHypervisorBundleStepRegex);
    if (cloudHypervisorBundleMatches) {
      content = content.replace(
        cloudHypervisorBundleStepRegex,
        (_match, indent: string, awfVersion: string) =>
          `${indent}- name: Download and verify cloud-hypervisor bundle\n` +
          `${indent}  id: cloud-hypervisor-bundle\n` +
          `${indent}  env:\n` +
          `${indent}    GH_AW_AWF_VERSION: ${awfVersion}\n` +
          `${indent}  run: |\n` +
          `${indent}    setup_status=0\n` +
          `${indent}    max_attempts=3\n` +
          `${indent}    for attempt in $(seq 1 "$max_attempts"); do\n` +
          `${indent}      if bash "\${RUNNER_TEMP}/gh-aw/actions/cloud_hypervisor_setup_bundle.sh"; then\n` +
          `${indent}        exit 0\n` +
          `${indent}      else\n` +
          `${indent}        setup_status=$?\n` +
          `${indent}      fi\n` +
          `${indent}      if [ "$attempt" -lt "$max_attempts" ]; then\n` +
          `${indent}        sleep $((attempt * 10))\n` +
          `${indent}      fi\n` +
          `${indent}    done\n` +
          `${indent}    exit "$setup_status"\n`
      );
      messages.push(
        `  Wrapped ${cloudHypervisorBundleMatches.length} Cloud Hypervisor bundle setup step(s) with retries`
      );
    }
  }
  return { content, messages };
}

export function installLocalAwf(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const preparedSmokeImages = usesPreparedSmokeImages(content, workflowPath);
  if (usesPublishedAwfRelease(workflowPath)) {
    messages.push(`  Preserved published AWF binary and images for maintenance workflow`);
  } else {
    installStepRegexGlobal.lastIndex = 0;
    const matches = content.match(installStepRegexGlobal);
    if (matches) {
      content = content.replace(
        installStepRegexGlobal,
        (_match, indent: string) => buildLocalInstallSteps(indent)
      );
      messages.push(`  Replaced ${matches.length} awf install step(s) with local build`);
    }
    // Only collapse byte-identical consecutive blocks, including >2 repeats.
    while (duplicateSetupNodeRegex.test(content)) {
      content = content.replace(duplicateSetupNodeRegex, '$1');
      messages.push(`  Collapsed duplicate consecutive Setup Node.js step`);
    }

    const lines = content.split('\n');
    let injectedCheckouts = 0;
    for (let i = 0; i < lines.length; i++) {
      const installMatch = lines[i].match(/^(\s+)- name: Install awf dependencies$/);
      if (!installMatch) continue;
      let hasCheckout = false;
      for (let j = i - 1; j >= 0; j--) {
        if (/^\s+- name: Checkout repository/.test(lines[j])) {
          // A conditional checkout does not guarantee that the repository exists.
          const nextLine = j + 1 < lines.length ? lines[j + 1] : '';
          if (/^\s+if:/.test(nextLine)) {
            continue;
          }
          hasCheckout = true;
          break;
        }
        if (/^  \S+:/.test(lines[j]) && !lines[j].startsWith('    ')) {
          break;
        }
      }
      if (!hasCheckout) {
        const indent = installMatch[1];
        const checkoutStep = [
          `${indent}- name: Checkout repository`,
          `${indent}  uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2`,
          `${indent}  with:`,
          `${indent}    persist-credentials: false`,
        ].join('\n');
        lines.splice(i, 0, checkoutStep);
        injectedCheckouts++;
        i += 4;
      }
    }
    if (injectedCheckouts > 0) {
      content = lines.join('\n');
      messages.push(`  Injected ${injectedCheckouts} checkout step(s) before awf build steps`);
    }
    const sparseMatches = content.match(sparseCheckoutRegex);
    if (sparseMatches) {
      content = content.replace(sparseCheckoutRegex, '');
      messages.push(`  Removed ${sparseMatches.length} sparse-checkout block(s)`);
    }
    const depthMatches = content.match(shallowDepthRegex);
    if (depthMatches) {
      content = content.replace(shallowDepthRegex, '');
      messages.push(`  Removed ${depthMatches.length} shallow depth setting(s)`);
    }
    const imageTagMatches = content.match(imageTagRegex);
    if (imageTagMatches) {
      content = content.replace(imageTagRegex, '--build-local');
      messages.push(`  Replaced ${imageTagMatches.length} --image-tag/--skip-pull with --build-local`);
    }
    standaloneSkipPullRegex.lastIndex = 0;
    const skipPullMatches = content.match(standaloneSkipPullRegex);
    if (skipPullMatches) {
      content = content.replace(standaloneSkipPullRegex, '--build-local');
      messages.push(`  Replaced ${skipPullMatches.length} standalone --skip-pull with --build-local`);
    }
    const isCloudHypervisorSmoke =
      /(?:^|[/\\])smoke-[^/\\]*cloud-hypervisor[^/\\]*\.lock\.yml$/.test(workflowPath);
    if (
      isCloudHypervisorSmoke &&
      content.includes('--cloud-hypervisor-preview') &&
      content.includes('--build-local')
    ) {
      const patched = patchLocalBuildCloudHypervisorArtifacts(content);
      if (patched !== content) {
        content = patched;
        messages.push('  Enabled hashed development artifacts for Cloud Hypervisor local build');
      }
    }
    // Remove only unreleased AWF images, not digest-pinned tool images.
    if (content.includes('--build-local')) {
      // Compiler-pinned images conflict with --build-local, including in routing configs.
      content = content.split('\n').map(line => {
        if (!line.includes("printf '%s\\n'") || !line.endsWith('/awf-config.json"')) {
          return line;
        }
        line = line.replace(
          /(,?)\\"images\\":\{[^{}\n]*\}(,?)/g,
          (_match, before: string, after: string) => before && after ? ',' : '',
        );
        line = line.replace(
          /(,?)\\"imageTag\\":\\"[^"\\]*\\"(,?)/g,
          (_match, before: string, after: string) => before && after ? ',' : '',
        );
        if (preparedSmokeImages && line.includes('\\"modelRouting\\":true')) {
          // Routing trusts checkout builds, not the mutable tags used by non-routing smokes.
          line = line.replace(/\\"container\\":(\{[^{}]*\})/, (_match, container: string) =>
            `\\"container\\":${JSON.stringify({
              ...JSON.parse(container.replace(/\\"/g, '"')),
              buildLocal: true,
            }).replace(/"/g, '\\"')}`,
          );
        }
        return line;
      }).join('\n');
      localAwfImageDownloadRegex.lastIndex = 0;
      const localAwfImageMatches = content.match(localAwfImageDownloadRegex);
      if (localAwfImageMatches) {
        content = content.replace(localAwfImageDownloadRegex, '');
        messages.push(`  Removed ${localAwfImageMatches.length} local AWF image download(s)`);
      }
    }
    if (preparedSmokeImages) {
      const preparation = content.match(
        /^ {6}- name: Build local AWF smoke images\n(?: {8}.*\n|\n)*/m,
      );
      const localInstall = /^ {6}- name: Install awf binary \(local\)\n(?: {8}.*\n|\n)*/m;
      if (!preparation || !localInstall.test(content)) {
        throw new Error('Smoke image preparation requires the local AWF install step');
      }
      const preserveHelperStep =
        '      - name: Preserve smoke image preparation helper\n' +
        '        run: |\n' +
        '          mkdir -p "${RUNNER_TEMP}/awf-smoke"\n' +
        '          cp "${GITHUB_WORKSPACE}/scripts/ci/build-smoke-images.sh" "${RUNNER_TEMP}/awf-smoke/build-smoke-images.sh"\n';
      if (!content.includes(preserveHelperStep)) {
        const prCheckout = /^      - name: Checkout PR branch\n        id: checkout-pr\n/m;
        if (!prCheckout.test(content)) {
          throw new Error('Smoke image preparation requires the PR checkout step');
        }
        content = content.replace(prCheckout, `${preserveHelperStep}$&`);
      }
      content = content.replace(preparation[0], '');
      content = content.replace(localInstall, step => step + preparation[0]);
      if (workflowPath.endsWith('smoke-services.lock.yml')) {
        const connectivity = content.match(
          /^ {6}- name: Require sandbox service connectivity\n(?: {8}.*\n|\n)*/m,
        );
        if (connectivity) {
          content = content.replace(connectivity[0], '');
          content = content.replace(preparation[0], step => step + connectivity[0]);
        }
      }
      const imageArgs = content.includes('\\"modelRouting\\":true')
        ? routingPreparedSmokeImageArgs
        : preparedSmokeImageArgs;
      content = content.split('\n').map(line => line.replace(
        /--build-local\b/g,
        /^\s*run: "/.test(line)
          ? JSON.stringify(imageArgs).slice(1, -1)
          : imageArgs,
      )).join('\n');
      messages.push('  Reused prepared PR images outside the smoke execution budget');
    }
  }
  return { content, messages };
}
