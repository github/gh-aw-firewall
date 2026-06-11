import * as fs from 'fs';
import * as path from 'path';
import { WrapperConfig } from './types';

function isDirectory(candidate: string): boolean {
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export function resolveRunnerToolCachePath(config: WrapperConfig, effectiveHome: string): string | undefined {
  const candidates = [
    config.runnerToolCachePath,
    process.env.RUNNER_TOOL_CACHE,
    path.join(effectiveHome, 'work', '_tool'),
  ];

  for (const candidate of candidates) {
    if (candidate && isDirectory(candidate)) {
      return candidate;
    }
  }

  return undefined;
}