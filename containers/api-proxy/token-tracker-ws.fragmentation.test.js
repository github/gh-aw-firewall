'use strict';

const { parseWebSocketFrames } = require('./token-tracker-ws');

/**
 * Build a WebSocket frame buffer.
 * @param {string} payload - Text payload
 * @param {object} opts
 * @param {boolean} [opts.fin=true] - FIN bit
 * @param {number} [opts.opcode=1] - Opcode (1=text, 0=continuation)
 */
function buildFrame(payload, { fin = true, opcode = 1 } = {}) {
  const buf = Buffer.from(payload, 'utf8');
  const len = buf.length;
  let header;

  const firstByte = (fin ? 0x80 : 0x00) | (opcode & 0x0F);

  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = firstByte;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = firstByte;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, buf]);
}

describe('parseWebSocketFrames', () => {
  describe('unfragmented messages', () => {
    it('extracts a single text frame', () => {
      const frame = buildFrame('{"type":"response.done"}');
      const { messages, consumed } = parseWebSocketFrames(frame);
      expect(messages).toEqual(['{"type":"response.done"}']);
      expect(consumed).toBe(frame.length);
    });

    it('extracts multiple text frames from a single buffer', () => {
      const frame1 = buildFrame('hello');
      const frame2 = buildFrame('world');
      const buf = Buffer.concat([frame1, frame2]);
      const { messages } = parseWebSocketFrames(buf);
      expect(messages).toEqual(['hello', 'world']);
    });
  });

  describe('fragmented messages', () => {
    it('reassembles a text message split across two frames', () => {
      const fragments = [];
      // First frame: FIN=0, opcode=text
      const frame1 = buildFrame('{"type":"resp', { fin: false, opcode: 1 });
      // Final continuation frame: FIN=1, opcode=continuation
      const frame2 = buildFrame('onse.done"}', { fin: true, opcode: 0 });

      const buf = Buffer.concat([frame1, frame2]);
      const { messages } = parseWebSocketFrames(buf, fragments);
      expect(messages).toEqual(['{"type":"response.done"}']);
    });

    it('reassembles a text message split across three frames', () => {
      const fragments = [];
      const frame1 = buildFrame('{"type"', { fin: false, opcode: 1 });
      const frame2 = buildFrame(':"response', { fin: false, opcode: 0 });
      const frame3 = buildFrame('.done"}', { fin: true, opcode: 0 });

      const buf = Buffer.concat([frame1, frame2, frame3]);
      const { messages } = parseWebSocketFrames(buf, fragments);
      expect(messages).toEqual(['{"type":"response.done"}']);
    });

    it('handles fragmentation across multiple data events', () => {
      const fragments = [];

      // First data event: start of fragmented message
      const frame1 = buildFrame('{"part":"one"', { fin: false, opcode: 1 });
      const result1 = parseWebSocketFrames(frame1, fragments);
      expect(result1.messages).toEqual([]);
      expect(fragments.length).toBe(1);

      // Second data event: final continuation frame
      const frame2 = buildFrame(', "part":"two"}', { fin: true, opcode: 0 });
      const result2 = parseWebSocketFrames(frame2, fragments);
      expect(result2.messages).toEqual(['{"part":"one", "part":"two"}']);
      expect(fragments.length).toBe(0);
    });

    it('handles mix of unfragmented and fragmented messages', () => {
      const fragments = [];
      const unfragmented = buildFrame('{"simple":true}');
      const frag1 = buildFrame('{"frag":', { fin: false, opcode: 1 });
      const frag2 = buildFrame('"yes"}', { fin: true, opcode: 0 });

      const buf = Buffer.concat([unfragmented, frag1, frag2]);
      const { messages } = parseWebSocketFrames(buf, fragments);
      expect(messages).toEqual(['{"simple":true}', '{"frag":"yes"}']);
    });
  });

  describe('backward compatibility', () => {
    it('works without fragments parameter (unfragmented only)', () => {
      const frame = buildFrame('hello');
      const { messages } = parseWebSocketFrames(frame);
      expect(messages).toEqual(['hello']);
    });

    it('silently skips fragmented messages without fragments parameter', () => {
      // FIN=0 text frame without fragments array — should be skipped
      const frame = buildFrame('partial', { fin: false, opcode: 1 });
      const { messages } = parseWebSocketFrames(frame);
      expect(messages).toEqual([]);
    });
  });
});
