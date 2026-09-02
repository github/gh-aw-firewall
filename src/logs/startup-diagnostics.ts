import * as fs from 'fs';
import * as path from 'path';
import type { LogSource, StartupDiagnostic } from '../types';

export const STARTUP_DIAGNOSTIC_FILENAME = 'awf-startup-error.json';

export function getStartupDiagnosticPath(logDir: string): string {
  return path.join(logDir, STARTUP_DIAGNOSTIC_FILENAME);
}

export function hasStartupDiagnostic(logDir: string): boolean {
  return fs.existsSync(getStartupDiagnosticPath(logDir));
}

export function readStartupDiagnostics(source: LogSource): StartupDiagnostic[] {
  if (source.type !== 'preserved' || !source.path) return [];

  const diagnosticPath = getStartupDiagnosticPath(source.path);
  if (!fs.existsSync(diagnosticPath)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(diagnosticPath, 'utf-8')) as Partial<StartupDiagnostic>;
    if (
      typeof parsed.timestamp === 'string' &&
      typeof parsed.phase === 'string' &&
      typeof parsed.message === 'string'
    ) {
      return [{
        timestamp: parsed.timestamp,
        phase: parsed.phase,
        message: parsed.message,
      }];
    }
  } catch {
    // Ignore malformed diagnostics; access.log remains the source of truth when present.
  }

  return [];
}

