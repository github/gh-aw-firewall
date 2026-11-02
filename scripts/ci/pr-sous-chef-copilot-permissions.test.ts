import * as path from 'path';
import { randomUUID } from 'crypto';

// Opt in with the checksum-verified runtime.node from the pinned Copilot release.
// Only its in-memory permission service runs: no inference, shell tools, or APIs.
const runtimePath = process.env.PR_SOUS_CHEF_COPILOT_RUNTIME;
const describeRuntime = runtimePath ? describe : describe.skip;

interface PermissionService {
  resetSessionApprovals(): void;
  addApprovedRules(rules: unknown[]): void;
  request(request: string): Promise<string>;
  dispose(): void;
}

interface PermissionRuntime {
  sessionCreate(config: string): Promise<{ dispose(): void }>;
  sessionPermissionsEnsureService(id: string, conventions: string): Promise<void>;
  permissionsParseRuleValue(rule: string): unknown;
  PermissionServiceHandle: new (config: Record<string, unknown>) => PermissionService;
}

describeRuntime('PR sous-chef pinned Copilot shell permissions', () => {
  it('reproduces multiword Node denial and authorizes only the dedicated executable', async () => {
    const runtime: PermissionRuntime = require(path.resolve(runtimePath!));
    const id = `pr-sous-chef-permissions-${randomUUID()}`;
    const session = await runtime.sessionCreate(JSON.stringify({
      sessionId: id,
      defaultIntegrationId: 'copilot-cli',
      updateOptionsJson: '{}',
      workingDirectoryConventions: 'posix',
      sessionFsIsLocal: false,
      isLocalSession: false,
      processWorkingDirectory: process.cwd(),
      initialWorkingDirectory: process.cwd(),
    }));
    let service: PermissionService | undefined;
    try {
      await runtime.sessionPermissionsEnsureService(id, 'posix');
      service = new runtime.PermissionServiceHandle({
        sessionId: id,
        approveAllTool: false,
        approveAllRead: false,
        autoApproval: false,
        approvedRules: [],
        deniedRules: [],
        hasRequestTool: false,
        hasRequestPath: false,
        hasRequestUrl: false,
      });
      const refresh = 'scripts/ci/pr-sous-chef-refresh';
      const nodeRefresh = 'node scripts/ci/pr-sous-chef.cjs --refresh';
      const denied = 'denied-no-approval-rule-and-could-not-request-from-user';
      for (const [rule, command, expected] of [
        [nodeRefresh, nodeRefresh, denied],
        ['node scripts/ci/pr-sous-chef.cjs:*', nodeRefresh, denied],
        ['node scripts/ci/pr-sous-chef.cjs --refresh:*', nodeRefresh, denied],
        ['node:*', 'node -e untrusted', 'approved'],
        [refresh, refresh, 'approved'],
        [refresh, nodeRefresh, denied],
        [refresh, 'node -e untrusted', denied],
        [refresh, 'scripts/ci/other-helper', denied],
      ]) {
        service.resetSessionApprovals();
        service.addApprovedRules([runtime.permissionsParseRuleValue(`shell(${rule})`)]);
        const identifier = command.split(' ')[0];
        const result = JSON.parse(await service.request(JSON.stringify({
          kind: 'shell',
          shellType: 'bash',
          fullCommandText: command,
          intention: 'Offline permission regression',
          commands: [{ identifier, readOnly: false, allowMatchIdentifier: null }],
          commandSegments: [{
            identifier,
            fullCommandText: command,
            allowMatchIdentifier: null,
            staticTokens: command.split(' '),
            hasUnboundExecutableContent: false,
            workingDirectory: process.cwd(),
          }],
          possiblePaths: [],
          possibleUrls: [],
          canOfferSessionApproval: true,
          hasWriteFileRedirection: false,
        })));
        expect({ rule, command, result: result.kind }).toEqual({ rule, command, result: expected });
      }
    } finally {
      service?.dispose();
      session.dispose();
    }
  });
});
