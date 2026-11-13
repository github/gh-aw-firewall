import type { PatchContext, TransformResult } from './types';

export function configureAzureSmoke(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  if (/(?:^|[/\\])smoke-copilot-byok-aoai-(?:apikey|entra)\.lock\.yml$/.test(workflowPath)) {
    const pricingCommand = 'node "${GITHUB_WORKSPACE}/scripts/ci/configure-aoai-smoke-pricing.cjs" ' +
      '"${RUNNER_TEMP}/gh-aw/awf-config.json" /tmp/gh-aw/awf-config.json';
    if (!content.includes(pricingCommand)) {
      const configCopy = /^([ \t]*)cp "\$\{RUNNER_TEMP\}\/gh-aw\/awf-config\.json" \/tmp\/gh-aw\/awf-config\.json$/m;
      if (!configCopy.test(content)) throw new Error(`Missing AWF config staging in Azure BYOK smoke: ${workflowPath}`);
      content = content.replace(configCopy, (match, indent: string) => `${match}\n${indent}${pricingCommand}`);
      messages.push('  Configured workflow-scoped Azure deployment pricing without changing budget limits');
    }
    if (!content.includes('"GITHUB_TOOLS": "list_pull_requests"')) {
      const githubToolsets = /^([ \t]*)"GITHUB_TOOLSETS": "pull_requests"$/m;
      if (githubToolsets.test(content)) {
        content = content.replace(
          githubToolsets,
          (_match, indent: string) =>
            `${indent}"GITHUB_TOOLSETS": "pull_requests",\n${indent}"GITHUB_TOOLS": "list_pull_requests"`,
        );
        messages.push('  Restricted the GitHub MCP catalog to list_pull_requests');
      }
    }
  }
  return { content, messages };
}
