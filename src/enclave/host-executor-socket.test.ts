import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { createHostExecutorSocket } from './host-executor-socket';
import {
  HOST_EXECUTOR_PROTOCOL_VERSION,
  frameHostExecutorMessage,
  type HostExecutorRequest,
  type HostExecutorResponse,
} from './host-executor-protocol';

describe('host executor socket framing boundary', () => {
  it('assembles fragmented headers and bodies, waits for EOF, and passes only decoded authenticated requests', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awf-host-socket-')));
    const socketPath = path.join(root, 'executor.sock');
    const capability = Buffer.alloc(32, 0xab);
    const request = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, type: 'status' as const, requestId: '1'.repeat(32),
      runId: 'a'.repeat(32), entryId: 'script', invocationId: 'b'.repeat(32),
    };
    const response: HostExecutorResponse = {
      version: HOST_EXECUTOR_PROTOCOL_VERSION, ok: false, requestId: request.requestId,
      error: 'unknown-invocation',
    };
    const handle = jest.fn((_request: HostExecutorRequest) => response);
    const diagnostics = { record: jest.fn() };
    const socket = createHostExecutorSocket({ socketPath, capability, runId: request.runId, handle, diagnostics });
    let client: net.Socket | undefined;
    try {
      await socket.listen();
      expect(fs.statSync(socketPath).mode & 0o777).toBe(0o600);
      client = net.createConnection(socketPath);
      const connection = client;
      const received = new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = [];
        connection.on('data', (chunk: Buffer) => chunks.push(chunk));
        connection.on('end', () => resolve(Buffer.concat(chunks)));
        connection.on('error', reject);
      });
      await new Promise<void>((resolve, reject) => {
        connection.once('connect', resolve);
        connection.once('error', reject);
      });
      const frame = frameHostExecutorMessage(Buffer.from(JSON.stringify({
        ...request, capability: capability.toString('hex'),
      })));
      for (const fragment of [frame.subarray(0, 1), frame.subarray(1, 4), frame.subarray(4, 20), frame.subarray(20)]) {
        connection.write(fragment);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        expect(handle).not.toHaveBeenCalled();
      }
      connection.end();
      const framedResponse = await received;
      expect(framedResponse.readUInt32BE(0)).toBe(framedResponse.length - 4);
      expect(JSON.parse(framedResponse.subarray(4).toString('utf8'))).toEqual(response);
      expect(handle.mock.calls).toEqual([[request]]);
      expect(diagnostics.record).not.toHaveBeenCalled();
    } finally {
      client?.destroy();
      socket.stopRequests();
      await socket.close();
      capability.fill(0);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
