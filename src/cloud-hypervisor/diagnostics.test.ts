import * as diagnostics from './diagnostics';
import { BoundedOutputCapture, readBoundedTail } from './diagnostics-capture';
import {
  DiagnosticPersistenceCleanupError,
  prepareRootOwnedDebugDirectory,
  writeAuditFile,
} from './diagnostics-paths';
import {
  prepareRunDirectory,
  stageArtifact,
  stageDiagnosticFile,
  preserveVirtiofsdStartupEvidence,
  preserveHostExecutorInvocationEvidence,
  preservePublicEnclaveSession,
  writeGuestOutputAudit,
} from './diagnostics-staging';
import { waitForApiSocket } from './diagnostics-readiness';
import { collectCloudHypervisorDiagnostics } from './diagnostics-collect';

describe('Cloud Hypervisor diagnostics facade', () => {
  it('preserves exactly the existing exports and their module identities', () => {
    expect(diagnostics).toEqual({
      BoundedOutputCapture,
      readBoundedTail,
      DiagnosticPersistenceCleanupError,
      prepareRootOwnedDebugDirectory,
      writeAuditFile,
      prepareRunDirectory,
      stageArtifact,
      stageDiagnosticFile,
      preserveVirtiofsdStartupEvidence,
      preserveHostExecutorInvocationEvidence,
      preservePublicEnclaveSession,
      writeGuestOutputAudit,
      waitForApiSocket,
      collectCloudHypervisorDiagnostics,
    });
  });
});
