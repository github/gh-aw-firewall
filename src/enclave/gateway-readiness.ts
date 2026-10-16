import type * as http from 'http';

export interface GatewayReadinessResponseErrorFactory {
  framing: () => Error;
  response: (error: Error) => Error;
  status: (status: number | null, raw: string) => Error;
}

export function readGatewayReadinessResponse(
  response: http.IncomingMessage,
  request: http.ClientRequest,
  errorFactory: GatewayReadinessResponseErrorFactory,
  maxBytes: number,
): Promise<{ response: http.IncomingMessage; raw: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const rejectOnce = (error: Error, destroyRequest = false): void => {
      if (settled) return;
      settled = true;
      reject(error);
      if (destroyRequest) request.destroy(error);
    };

    response.on('error', error => rejectOnce(errorFactory.response(error)));
    response.on('data', chunk => {
      total += Buffer.byteLength(chunk);
      if (total > maxBytes) {
        rejectOnce(errorFactory.framing(), true);
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    response.on('end', () => {
      if (settled) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      const status = response.statusCode ?? null;
      if (status !== 200 && status !== 202) {
        rejectOnce(errorFactory.status(status, raw));
        return;
      }
      settled = true;
      resolve({ response, raw });
    });
  });
}
