export function createRpcTestHarness(canonicalErrorResponse: string) {
  function rpc(method: string, params?: unknown, id = 1) {
    return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
  }

  function fakeBroker(response: string, requests: unknown[] = []) {
    return {
      handle(request: unknown, respond: (value: string) => void) {
        requests.push(request);
        respond(response);
        return Promise.resolve();
      },
    };
  }

  return {
    rpc,
    fakeBroker,
    canonicalErrorBroker: (requests: unknown[] = []) => fakeBroker(canonicalErrorResponse, requests),
  };
}
