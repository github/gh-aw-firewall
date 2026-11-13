import type { PatchContext, TransformResult } from './types';

export function excludeAuditorCredentials(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  if (workflowPath.endsWith('workflow-runtime-auditor.lock.yml')) {
    const exclusions = [
      'GH_AW_DEFAULT_OTLP_HEADERS',
      'GH_AW_OTLP_ENDPOINTS',
      'OTEL_EXPORTER_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_ENDPOINT',
    ];
    let commandCount = 0;
    content = content.split('\n').map(line => {
      if (!/^\s*awf --config\b/.test(line) || !line.includes('--env-all')) return line;
      commandCount++;
      for (const name of exclusions) {
        if (!line.includes(`--exclude-env ${name}`)) {
          line = line.replace('--env-all', `--env-all --exclude-env ${name}`);
        }
      }
      return line;
    }).join('\n');
    if (commandCount < 2) {
      throw new Error(`Expected both AWF sandbox commands in ${workflowPath}`);
    }
    messages.push('  Excluded OTLP credentials from both auditor sandboxes');
  }
  return { content, messages };
}

export function restrictRecoveryRoots(content: string, { workflowFile }: PatchContext): TransformResult {
  const messages: string[] = [];
  if (workflowFile === 'self-hosted-runner-doctor-updater.lock.yml') {
    const before = content;
    content = content.replace(
      /^(\s*GH_AW_RECOVERY_ADDITIONAL_ROOTS: )'(\[[^\n]*\])'$/gm,
      (_match, prefix: string, encodedRoots: string) => {
        const roots = JSON.parse(encodedRoots) as string[];
        const filteredRoots = roots.filter(
          root => root !== '/tmp/gh-aw' && root !== '/tmp/gh-aw/proxy-logs/',
        );
        return `${prefix}'${JSON.stringify(filteredRoots)}'`;
      },
    );
    if (content !== before) {
      messages.push('  Removed broad recovery roots from the runner doctor updater');
    }
  }
  return { content, messages };
}

// gh-aw v0.87.0 supplies the Azure authentication IDs but omits their exclusions from --env-all.
export function excludeAzureCredentials(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const isCopilotByokAoaiEntraSmoke = workflowPath.endsWith(
    'smoke-copilot-byok-aoai-entra.lock.yml'
  );
  if (isCopilotByokAoaiEntraSmoke) {
    const oidcExclusions =
      '--exclude-env ACTIONS_ID_TOKEN_REQUEST_TOKEN --exclude-env ACTIONS_ID_TOKEN_REQUEST_URL';
    const azureExclusions =
      ' --exclude-env AWF_AUTH_AZURE_CLIENT_ID --exclude-env AWF_AUTH_AZURE_TENANT_ID';
    if (!content.includes('--exclude-env AWF_AUTH_AZURE_CLIENT_ID')) {
      if (content.includes(oidcExclusions)) {
        content = content.replace(oidcExclusions, oidcExclusions + azureExclusions);
        messages.push(`  Restored Azure OIDC environment exclusions from the AWF invocation`);
      } else {
        throw new Error(
          `Could not find OIDC environment exclusions anchor while patching ${workflowPath}; refusing to continue without Azure OIDC protection`
        );
      }
    } else {
      messages.push(`  Azure OIDC environment exclusions already present`);
    }
  }
  return { content, messages };
}
