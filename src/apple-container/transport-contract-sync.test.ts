/**
 * Keeps the two halves of the transport contract in lockstep.
 *
 * The host half lives in `transport-capabilities.ts` and the guest half is
 * compiled into `guest/apple-container-init/contract.go`. Neither side can
 * discover the other at runtime — that is the point, since no configuration
 * crosses the VM boundary at boot — so a silent divergence would surface only
 * as a capability that mysteriously does not work inside a real VM. This test
 * turns that into a build failure instead.
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  APPLE_CONTAINER_INIT_ENTRYPOINT,
  APPLE_CONTAINER_TRANSPORT_CAPABILITIES,
  APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION,
  APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY,
  APPLE_CONTAINER_VMINITD_PATH,
} from './transport-capabilities';

const CONTRACT_GO = path.join(
  __dirname,
  '..',
  '..',
  'guest',
  'apple-container-init',
  'contract.go',
);

function readContract(): string {
  return fs.readFileSync(CONTRACT_GO, 'utf8');
}

function goStringConstant(source: string, name: string): string {
  const match = new RegExp(`const ${name} = "([^"]*)"`).exec(source);
  if (!match) throw new Error(`contract.go does not declare a string constant ${name}`);
  return match[1];
}

function goIntConstant(source: string, name: string): number {
  const match = new RegExp(`const ${name} = (\\d+)`).exec(source);
  if (!match) throw new Error(`contract.go does not declare an integer constant ${name}`);
  return Number(match[1]);
}

interface GoCapability {
  readonly id: string;
  readonly socketName: string;
  readonly guestPort: number;
}

function goCapabilities(source: string): GoCapability[] {
  const block = /var Capabilities = \[\]Capability\{([\s\S]*?)\n\}/.exec(source);
  if (!block) throw new Error('contract.go does not declare a Capabilities slice');
  const entry = /\{ID: "([^"]+)", SocketName: "([^"]+)", GuestPort: (\d+)\}/g;
  const capabilities: GoCapability[] = [];
  let match = entry.exec(block[1]);
  while (match) {
    capabilities.push({ id: match[1], socketName: match[2], guestPort: Number(match[3]) });
    match = entry.exec(block[1]);
  }
  if (capabilities.length === 0) throw new Error('contract.go declares no capabilities');
  return capabilities;
}

describe('Apple Container transport host/guest contract', () => {
  const source = readContract();

  it('agrees on the contract version and guest directory', () => {
    expect(goIntConstant(source, 'ContractVersion'))
      .toBe(APPLE_CONTAINER_TRANSPORT_CONTRACT_VERSION);
    expect(goStringConstant(source, 'GuestDirectory'))
      .toBe(APPLE_CONTAINER_TRANSPORT_GUEST_DIRECTORY);
  });

  it('agrees on the init entrypoint and the relocated Apple init path', () => {
    expect(goStringConstant(source, 'InitEntrypoint')).toBe(APPLE_CONTAINER_INIT_ENTRYPOINT);
    expect(goStringConstant(source, 'RealInitPath')).toBe(APPLE_CONTAINER_VMINITD_PATH);
  });

  it('agrees on the exact capability set, socket names, and guest ports', () => {
    const guest = goCapabilities(source)
      .map((capability) => `${capability.id}|${capability.socketName}|${capability.guestPort}`)
      .sort();
    const host = APPLE_CONTAINER_TRANSPORT_CAPABILITIES
      .map((capability) => `${capability.id}|${capability.socketName}|${capability.guestPort}`)
      .sort();
    expect(guest).toEqual(host);
  });

  it('serves no guest port that the host cannot publish a socket for', () => {
    const hostIds = new Set<string>(APPLE_CONTAINER_TRANSPORT_CAPABILITIES.map((c) => c.id));
    for (const capability of goCapabilities(source)) {
      expect(hostIds.has(capability.id)).toBe(true);
    }
  });
});
