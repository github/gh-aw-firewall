import * as fs from 'fs';
import * as path from 'path';
import type { BoundedAgentPaths } from './paths';

// In the standalone bundle this global is replaced at build time with the
// wrapper source. Normal source/npm builds read the checked-in shell script.
declare const __AWF_BOUNDED_AGENT_WRAPPER__: string | undefined;

function loadWrapperSource(): string {
  if (typeof __AWF_BOUNDED_AGENT_WRAPPER__ !== 'undefined') {
    return __AWF_BOUNDED_AGENT_WRAPPER__;
  }

  const candidates = [
    path.join(__dirname, '..', '..', 'containers', 'agent', 'bounded-agent-wrapper.sh'),
    path.join(__dirname, '..', '..', '..', 'containers', 'agent', 'bounded-agent-wrapper.sh'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return fs.readFileSync(candidate, 'utf8');
  }
  throw new Error(`Bounded-agent wrapper not found at ${candidates.join(' or ')}`);
}

/** Materializes the wrapper in the agent-only ingress root. */
export function writeBoundedAgentWrapper(paths: BoundedAgentPaths): string {
  const fd = fs.openSync(
    paths.wrapperPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o700,
  );
  try {
    fs.writeSync(fd, loadWrapperSource());
    fs.fchmodSync(fd, 0o555);
  } finally {
    fs.closeSync(fd);
  }
  return paths.wrapperPath;
}
