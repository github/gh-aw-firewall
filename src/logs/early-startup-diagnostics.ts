import * as fs from 'fs';
import schema from './early-startup-schema.json';

type EarlyStartupPhase = keyof typeof schema.phases;
interface EarlyStartupContext {
  phase: EarlyStartupPhase;
  emitted: boolean;
}
let active: EarlyStartupContext | undefined;

/** Capture synchronous validation exits before a work directory or startup record exists. */
export function withEarlyStartupDiagnostics<T>(phase: EarlyStartupPhase, operation: () => T): T {
  const parent = active;
  const context = parent ?? { phase, emitted: false };
  const previousPhase = context.phase;
  context.phase = phase;
  active = context;
  const emit = (error?: unknown): void => {
    if (context.emitted) return;
    context.emitted = true;
    const code = (error as { code?: unknown } | undefined)?.code;
    const reason = typeof code === 'string' && Object.prototype.hasOwnProperty.call(schema.reasons, code)
      ? code : schema.phases[context.phase];
    try {
      fs.writeSync(2, `AWF_EARLY_STARTUP_FAILURE ${JSON.stringify({
        schemaVersion: 1, phase: context.phase, reason,
      })}\n`);
    } catch {
      // Diagnostic publication must not replace the original failure.
    }
  };
  const onExit = (code: number): void => { if (code !== 0) emit(); };
  if (!parent) process.once('exit', onExit);
  try {
    return operation();
  } catch (error) {
    emit(error);
    throw error;
  } finally {
    context.phase = previousPhase;
    active = parent;
    if (!parent) process.removeListener('exit', onExit);
  }
}
