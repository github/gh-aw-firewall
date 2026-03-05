/**
 * Helpers for extracting structured data from stdout that may contain
 * Docker build output or other noise preceding the actual command output.
 *
 * When --build-local is used, Docker build logs are interleaved in stdout
 * before the actual curl/command output. These helpers find the relevant
 * data by scanning from the end of the output.
 */

/**
 * Extract the last complete JSON object from a string that may contain
 * non-JSON content (e.g., Docker build logs) before the JSON payload.
 *
 * Scans backwards from the end to find the last `}`, then walks backwards
 * tracking brace depth to find the matching `{`.
 *
 * @param output - The full stdout string
 * @returns The parsed JSON object, or null if no valid JSON object found
 */
export function extractLastJson(output: string): any | null {
  // Find the last closing brace
  const lastBrace = output.lastIndexOf('}');
  if (lastBrace === -1) return null;

  // Walk backwards from the last '}' to find the matching '{'
  let depth = 0;
  for (let i = lastBrace; i >= 0; i--) {
    if (output[i] === '}') depth++;
    if (output[i] === '{') depth--;
    if (depth === 0) {
      // Found the matching opening brace
      const jsonStr = output.substring(i, lastBrace + 1);
      try {
        return JSON.parse(jsonStr);
      } catch {
        // This wasn't valid JSON, keep scanning
        // (edge case: unbalanced braces in Docker build output)
        continue;
      }
    }
  }

  return null;
}

/**
 * Extract the last line(s) of stdout that look like actual command output
 * (i.e., not Docker build step output).
 *
 * Docker build output lines typically start with patterns like:
 *   #1 [internal] load ...
 *   #5 DONE 0.1s
 *   => [1/5] FROM ...
 *
 * This returns everything after the last Docker build output line.
 *
 * @param output - The full stdout string
 * @returns The cleaned output with Docker build noise removed
 */
export function extractCommandOutput(output: string): string {
  const lines = output.split('\n');

  // Find the last line that looks like Docker build output
  let lastBuildLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith('#') && /^#\d+/.test(line) || // Docker buildkit steps
      line.startsWith('=>') || // Docker buildkit arrows
      line.startsWith('DONE') ||
      line.startsWith('CACHED') ||
      line.match(/^\[[\d/]+\]/) || // Docker build step progress
      line.startsWith('Sending build context') ||
      line.startsWith('Successfully built') ||
      line.startsWith('Successfully tagged')
    ) {
      lastBuildLine = i;
    }
  }

  if (lastBuildLine === -1) {
    return output; // No Docker build output detected
  }

  // Return everything after the last build line
  return lines.slice(lastBuildLine + 1).join('\n').trim();
}
