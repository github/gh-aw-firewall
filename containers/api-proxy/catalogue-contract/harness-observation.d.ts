import { ModelScope } from './resolution';
import { EligibilityInput } from './eligibility';

export interface HarnessSelection { name: string; binary: string }
export interface HarnessContext { environment: string; name?: string; binary?: string }
export type HarnessObservationReport = HarnessContext & (
  { status: 'observed'; version: string; resolvedBinary: string } |
  { status: 'unavailable'; reason: string }
);
export interface HarnessProbeResult {
  stdout: string;
  exitCode: number;
  timedOut?: boolean;
  overflow?: boolean;
}
export type HarnessProbe = (command: string) => Promise<HarnessProbeResult>;
export const MAX_PROBE_BYTES: number;
export function selectHarness(command: string): HarnessSelection | undefined;
export function unavailable(context: HarnessContext, reason: string): HarnessObservationReport;
export function probeCommand(selection: HarnessSelection): string;
export function parseProbe(context: HarnessContext, result: HarnessProbeResult): HarnessObservationReport;
export function validateObservation(value: unknown, context: HarnessContext): HarnessObservationReport;
export function eligibilityEvidence(report: HarnessObservationReport, scope: ModelScope):
  Pick<EligibilityInput, 'executionEnvironment' | 'selectedHarness' | 'observations'>;
