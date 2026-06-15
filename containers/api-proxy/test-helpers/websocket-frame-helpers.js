'use strict';

/**
 * Build a minimal unmasked WebSocket text frame for a given UTF-8 string.
 * Only supports payloads up to 125 bytes (single-byte length field).
 *
 * @param {string} text  JSON (or any string) to encode as a WS text frame
 * @returns {Buffer}
 */
function buildFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const header = Buffer.alloc(2);
  header[0] = 0x81; // FIN + opcode 1 (text)
  header[1] = payload.length;
  return Buffer.concat([header, payload]);
}

/**
 * Return the standard HTTP/1.1 101 Switching Protocols header buffer used in
 * all Anthropic WebSocket upgrade tests.
 *
 * @returns {Buffer}
 */
function buildHttpUpgradeHeader() {
  return Buffer.from('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n');
}

/**
 * Build the canonical Anthropic streaming WebSocket payload consisting of:
 *  - HTTP 101 upgrade header
 *  - `message_start` frame  (input_tokens: 20, output_tokens: 0)
 *  - `message_delta` frame  (output_tokens: 8)
 *
 * @returns {Buffer}  A single buffer ready to emit on the socket 'data' event
 */
function buildAnthropicUsageFrames() {
  const httpHeader = buildHttpUpgradeHeader();
  const frame1 = buildFrame(JSON.stringify({
    type: 'message_start',
    message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 20, output_tokens: 0 } },
  }));
  const frame2 = buildFrame(JSON.stringify({
    type: 'message_delta',
    usage: { output_tokens: 8 },
  }));
  return Buffer.concat([httpHeader, frame1, frame2]);
}

module.exports = { buildFrame, buildHttpUpgradeHeader, buildAnthropicUsageFrames };
