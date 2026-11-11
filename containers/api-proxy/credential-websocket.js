'use strict';

const { Transform } = require('stream');
const { STATUS_CODES } = require('http');
const { maskCredentialPrefix } = require('./credential-protection');

const MAX_HANDSHAKE_BYTES = 16 * 1024;
const MAX_PENDING_FRAMING_BYTES = 64 * 1024;

/**
 * Mask payload bytes without changing frame lengths or message fragmentation.
 * Only a possible credential suffix (plus bounded intervening framing/control
 * bytes) is retained, never an entire model message.
 */
function createWebSocketCredentialTransform(req) {
  let handshake = Buffer.alloc(0);
  let upgraded = false;
  let rejected = false;
  let header = Buffer.alloc(0);
  let frame = null;
  const pending = [];
  let framingBytes = 0;

  function flushPayload(stream, final = false) {
    const payload = Buffer.concat(pending.filter(part => part.payload).map(part => part.bytes));
    let safeBytes = maskCredentialPrefix(req, payload, final);
    let offset = 0;
    for (const part of pending) {
      if (!part.payload) continue;
      payload.copy(part.bytes, 0, offset, offset + part.bytes.length);
      offset += part.bytes.length;
    }
    while (pending.length) {
      const part = pending[0];
      if (!part.payload) {
        stream.push(part.bytes);
        framingBytes -= part.bytes.length;
        pending.shift();
      } else {
        const length = Math.min(safeBytes, part.bytes.length);
        if (!length) break;
        stream.push(part.bytes.subarray(0, length));
        safeBytes -= length;
        if (length === part.bytes.length) pending.shift();
        else part.bytes = part.bytes.subarray(length);
      }
    }
    if (framingBytes > MAX_PENDING_FRAMING_BYTES) throw new Error('Upstream WebSocket pending framing limit exceeded');
  }

  function addFraming(bytes) {
    pending.push({ bytes, payload: false });
    framingBytes += bytes.length;
  }

  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        let input = chunk;
        if (rejected) return callback();
        if (!upgraded) {
          handshake = Buffer.concat([handshake, input]);
          const end = handshake.indexOf('\r\n\r\n');
          if (end === -1) {
            if (handshake.length > MAX_HANDSHAKE_BYTES) throw new Error('Upstream WebSocket handshake limit exceeded');
            return callback();
          }
          if (end + 4 > MAX_HANDSHAKE_BYTES) throw new Error('Upstream WebSocket handshake limit exceeded');
          const text = handshake.subarray(0, end + 4).toString('latin1');
          const status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: |\r)/.exec(text);
          if (!status) throw new Error('Invalid upstream WebSocket handshake');
          if (status[1] !== '101') {
            // Rejected upgrades may carry compressed or chunked diagnostics.
            // Preserve the status, but never tunnel their opaque error bodies.
            const code = Number(status[1]);
            this.push(`HTTP/1.1 ${code} ${STATUS_CODES[code] || 'Upstream Error'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            rejected = true;
            handshake = Buffer.alloc(0);
            this.emit('upgradeRejected');
            return callback();
          }
          if (/\r\nsec-websocket-extensions\s*:/i.test(text)) {
            throw new Error('Unrequested upstream WebSocket extension');
          }
          maskCredentialPrefix(req, handshake.subarray(0, end + 4), true);
          this.push(handshake.subarray(0, end + 4));
          input = handshake.subarray(end + 4);
          handshake = Buffer.alloc(0);
          upgraded = true;
        }

        while (input.length) {
          if (!frame) {
            // Frame headers are at most ten bytes in the unmasked server direction.
            const needed = header.length < 2 ? 2 : (header[1] & 0x7f) === 126 ? 4 : (header[1] & 0x7f) === 127 ? 10 : 2;
            const take = Math.min(needed - header.length, input.length);
            header = Buffer.concat([header, input.subarray(0, take)]);
            input = input.subarray(take);
            if (header.length < 2) continue;
            const size = header[1] & 0x7f;
            const headerLength = size === 126 ? 4 : size === 127 ? 10 : 2;
            if (header.length < headerLength) continue;
            const opcode = header[0] & 0x0f;
            const fin = (header[0] & 0x80) !== 0;
            if ((header[0] & 0x70) || (header[1] & 0x80) || ![0, 1, 2, 8, 9, 10].includes(opcode)) {
              throw new Error('Unsupported upstream WebSocket frame');
            }
            const length = size === 127 ? Number(header.readBigUInt64BE(2)) : size === 126 ? header.readUInt16BE(2) : size;
            if (!Number.isSafeInteger(length) || (opcode >= 8 && (!fin || length > 125))) {
              throw new Error('Invalid upstream WebSocket frame length');
            }
            frame = { remaining: length, fin, opcode, control: [] };
            if (opcode === 8) flushPayload(this, true);
            if (opcode !== 9) addFraming(header);
            header = Buffer.alloc(0);
          }
          const take = Math.min(frame.remaining, input.length);
          const bytes = Buffer.from(input.subarray(0, take));
          input = input.subarray(take);
          frame.remaining -= take;
          if (frame.opcode >= 8) frame.control.push(bytes);
          else if (bytes.length) pending.push({ bytes, payload: true });
          if (frame.remaining === 0) {
            if (frame.opcode >= 8) {
              const control = Buffer.concat(frame.control);
              if (frame.opcode === 9) {
                this.emit('ping', control);
              } else {
                // Preserve the two-byte close status; only the reason is text.
                const start = frame.opcode === 8 ? Math.min(2, control.length) : 0;
                maskCredentialPrefix(req, control.subarray(start), true);
                addFraming(control);
              }
            }
            const final = frame.fin && frame.opcode < 8;
            flushPayload(this, final);
            frame = null;
          } else if (frame.opcode < 8) {
            flushPayload(this);
          }
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    flush(callback) {
      if (!rejected && (!upgraded || header.length || frame)) {
        callback(new Error('Truncated upstream WebSocket response'));
        return;
      }
      try {
        flushPayload(this, true);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });
}

module.exports = { createWebSocketCredentialTransform };
