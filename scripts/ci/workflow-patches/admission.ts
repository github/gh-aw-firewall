import type { PatchContext, TransformResult } from './types';

export function declareDisabledAdmissionOutputs(content: string, { workflowPath }: PatchContext): TransformResult {
  const messages: string[] = [];
  const manifest = content.match(/^# gh-aw-manifest: (.+)$/m);
  if (manifest && (JSON.parse(manifest[1]) as { admission?: boolean }).admission === false) {
    const references = new Set(
      [...content.matchAll(/needs\.activation\.outputs\.(admission-[\w-]+)/g)]
        .map(match => match[1]),
    );
    const outputNames = [
      'admission-result',
      'admission-max-ai-credits',
      'admission-max-ai-credits-threat-detection',
      'admission-max-ai-credits-evals',
    ].filter(name => references.has(name));
    if (outputNames.length > 0) {
      const lines = content.split('\n');
      const activation = lines.indexOf('  activation:');
      const nextJob = lines.findIndex((line, index) =>
        index > activation && /^ {2}\S/.test(line));
      const end = nextJob === -1 ? lines.length : nextJob;
      const outputs = lines.findIndex((line, index) =>
        index > activation && index < end && line === '    outputs:');
      if (activation === -1 || outputs === -1) {
        throw new Error(`Missing activation outputs for disabled admission: ${workflowPath}`);
      }
      let outputsEnd = outputs + 1;
      while (outputsEnd < end &&
        (lines[outputsEnd].startsWith('      ') || lines[outputsEnd].trim() === '')) outputsEnd++;
      const declarations = lines.slice(outputs + 1, outputsEnd);
      const missing = outputNames.filter(name =>
        !declarations.some(line => line.startsWith(`      ${name}:`)));
      if (missing.length > 0) {
        lines.splice(outputs + 1, 0, ...missing.map(name => `      ${name}: ""`));
        content = lines.join('\n');
        messages.push('  Declared empty optional outputs for disabled admission');
      }
    }
  }
  return { content, messages };
}
