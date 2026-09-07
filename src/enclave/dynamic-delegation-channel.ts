/**
 * Host side of the AWF-private dynamic delegation channel.
 *
 * The loop watches one `0700` directory inside the enclave private root for
 * broker-written admission requests and settlement reports, answers each one
 * exactly once through {@link DynamicDelegationService}, and writes the reply
 * atomically (temp file + `rename`) so the broker can never observe a partial
 * document.
 *
 * There is no network listener and no long-lived shared secret on this path:
 * the directory is bind-mounted only into the enclave MCP broker, which is
 * already the trusted component that launches executors. See
 * `./dynamic-delegation-protocol` for why the control client cannot live in
 * the broker container.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import type { DynamicDelegationService } from './dynamic-delegation-service';
import {
  DELEGATION_CHANNEL_MAX_BYTES,
  DELEGATION_CHANNEL_RECEIPT_SUFFIX,
  DELEGATION_CHANNEL_REQUEST_SUFFIX,
  DELEGATION_CHANNEL_RESPONSE_SUFFIX,
  DELEGATION_CHANNEL_SETTLE_SUFFIX,
  parseDelegationAdmissionRequest,
  parseDelegationSettlement,
} from './dynamic-delegation-protocol';

/** How often the host sweeps the channel directory. */
const POLL_INTERVAL_MS = 25;

export interface DynamicDelegationChannelOptions {
  directory: string;
  service: DynamicDelegationService;
  pollIntervalMs?: number;
}

export interface DynamicDelegationChannel {
  /** Processes one sweep. Exposed so tests can drive the loop deterministically. */
  poll(): Promise<void>;
  stop(): Promise<void>;
}

function readBoundedJson(target: string): unknown | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > DELEGATION_CHANNEL_MAX_BYTES) return undefined;
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function writeAtomicJson(target: string, value: unknown): void {
  const temporary = `${target}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, target);
}

/**
 * Starts the channel loop. The returned handle keeps a single sweep in flight
 * at a time, so a slow control call can never overlap itself.
 */
export function startDynamicDelegationChannel(
  options: DynamicDelegationChannelOptions,
): DynamicDelegationChannel {
  const { directory, service } = options;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const handled = new Set<string>();
  let stopped = false;
  let inFlight: Promise<void> = Promise.resolve();

  const handleRequest = async (entry: string): Promise<void> => {
    const source = path.join(directory, entry);
    const invocationId = entry.slice(0, -DELEGATION_CHANNEL_REQUEST_SUFFIX.length);
    const request = parseDelegationAdmissionRequest(readBoundedJson(source));
    fs.rmSync(source, { force: true });
    if (!request || request.invocationId !== invocationId) {
      logger.warn('Enclaves: discarded a malformed dynamic delegation admission request.');
      return;
    }
    const response = await service.admit(request);
    writeAtomicJson(
      path.join(directory, `${invocationId}${DELEGATION_CHANNEL_RESPONSE_SUFFIX}`),
      response,
    );
  };

  const handleSettlement = async (entry: string): Promise<void> => {
    const source = path.join(directory, entry);
    const invocationId = entry.slice(0, -DELEGATION_CHANNEL_SETTLE_SUFFIX.length);
    const settlement = parseDelegationSettlement(readBoundedJson(source));
    fs.rmSync(source, { force: true });
    if (!settlement || settlement.invocationId !== invocationId) {
      logger.warn('Enclaves: discarded a malformed dynamic delegation settlement report.');
      return;
    }
    const receipt = await service.settle(settlement);
    writeAtomicJson(
      path.join(directory, `${invocationId}${DELEGATION_CHANNEL_RECEIPT_SUFFIX}`),
      receipt,
    );
  };

  const poll = async (): Promise<void> => {
    let entries: string[];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (handled.has(entry)) continue;
      if (entry.endsWith(DELEGATION_CHANNEL_REQUEST_SUFFIX)) {
        handled.add(entry);
        await handleRequest(entry);
      } else if (entry.endsWith(DELEGATION_CHANNEL_SETTLE_SUFFIX)) {
        handled.add(entry);
        await handleSettlement(entry);
      }
    }
  };

  const timer = setInterval(() => {
    if (stopped) return;
    inFlight = inFlight.then(poll).catch((error) => {
      logger.warn('Enclaves: dynamic delegation channel sweep failed.', error);
    });
  }, options.pollIntervalMs ?? POLL_INTERVAL_MS);
  timer.unref?.();

  return {
    poll,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
