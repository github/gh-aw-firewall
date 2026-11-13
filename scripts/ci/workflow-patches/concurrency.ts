import type { PatchContext, TransformResult } from './types';

export const issueDuplicationConclusionConcurrencyRegex =
  /([ ]+group: "gh-aw-conclusion-issue-duplication-detector)("\n[ ]+cancel-in-progress: false)/;
export const issueDuplicationConclusionConcurrencySentinel =
  'gh-aw-conclusion-issue-duplication-detector-${{ github.event.issue.number';

export function scopeConclusionConcurrency(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const isIssueDuplicationDetector = workflowPath.includes(
    'issue-duplication-detector.lock.yml'
  );
  if (isIssueDuplicationDetector) {
    if (!content.includes(issueDuplicationConclusionConcurrencySentinel)) {
      const concMatch = content.match(issueDuplicationConclusionConcurrencyRegex);
      if (concMatch) {
        content = content.replace(
          issueDuplicationConclusionConcurrencyRegex,
          `$1-\${{ github.event.issue.number || github.run_id }}$2`
        );
        messages.push(`  Scoped conclusion concurrency group to per-issue for issue-duplication-detector`);
      } else {
        messages.push(
          `  WARNING: Could not find conclusion concurrency group in issue-duplication-detector. ` +
            `The compiled lock file may have changed structure. Manual review required.`
        );
      }
    } else {
      messages.push(`  Conclusion concurrency group already per-issue for issue-duplication-detector`);
    }
  }
  return { content, messages };
}
