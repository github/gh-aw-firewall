'use strict';

/** Mirrors src/bounded-execution/strict-json-parser.ts. Keep both implementations in parity. */

function utf8ByteLength(value) {
  return Buffer.byteLength(value, 'utf8');
}

// ── Strict JSON parsing (no `JSON.parse`) ────────────────────────────────────

const MAX_JSON_PARSE_DEPTH = 32;
const JSON_WHITESPACE = new Set([' ', '\t', '\n', '\r']);

function skipJsonWhitespace(text, index) {
  let i = index;
  while (i < text.length && JSON_WHITESPACE.has(text[i])) i++;
  return i;
}

function parseJsonStringLiteral(text, start) {
  if (text[start] !== '"') return undefined;

  let i = start + 1;
  let value = '';
  while (i < text.length) {
    const ch = text[i];

    if (ch === '"') return { value, endIndex: i + 1 };

    if (ch === '\\') {
      const escape = text[i + 1];
      switch (escape) {
        case '"': value += '"'; i += 2; continue;
        case '\\': value += '\\'; i += 2; continue;
        case '/': value += '/'; i += 2; continue;
        case 'b': value += '\b'; i += 2; continue;
        case 'f': value += '\f'; i += 2; continue;
        case 'n': value += '\n'; i += 2; continue;
        case 'r': value += '\r'; i += 2; continue;
        case 't': value += '\t'; i += 2; continue;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return undefined;
          value += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        default:
          return undefined;
      }
    }

    if (ch.charCodeAt(0) < 0x20) return undefined;
    value += ch;
    i++;
  }

  return undefined;
}

function parseJsonNumber(text, start) {
  let i = start;
  if (text[i] === '-') i++;
  if (text[i] === '0') {
    i++;
  } else if (text[i] >= '1' && text[i] <= '9') {
    while (text[i] >= '0' && text[i] <= '9') i++;
  } else {
    return undefined;
  }
  if (text[i] === '.') {
    i++;
    if (!(text[i] >= '0' && text[i] <= '9')) return undefined;
    while (text[i] >= '0' && text[i] <= '9') i++;
  }
  if (text[i] === 'e' || text[i] === 'E') {
    i++;
    if (text[i] === '+' || text[i] === '-') i++;
    if (!(text[i] >= '0' && text[i] <= '9')) return undefined;
    while (text[i] >= '0' && text[i] <= '9') i++;
  }
  const raw = text.slice(start, i);
  const value = Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return { value, endIndex: i };
}

function parseJsonValue(text, index, depth) {
  if (depth > MAX_JSON_PARSE_DEPTH) return undefined;
  const ch = text[index];

  if (ch === '{') return parseJsonObject(text, index, depth);
  if (ch === '[') return parseJsonArray(text, index, depth);
  if (ch === '"') {
    const literal = parseJsonStringLiteral(text, index);
    return literal && { value: literal.value, endIndex: literal.endIndex };
  }
  if (text.startsWith('true', index)) return { value: true, endIndex: index + 4 };
  if (text.startsWith('false', index)) return { value: false, endIndex: index + 5 };
  if (text.startsWith('null', index)) return { value: null, endIndex: index + 4 };
  if (ch === '-' || (ch >= '0' && ch <= '9')) return parseJsonNumber(text, index);
  return undefined;
}

function parseJsonObject(text, index, depth) {
  let i = skipJsonWhitespace(text, index + 1);
  const obj = {};
  if (text[i] === '}') return { value: obj, endIndex: i + 1 };

  for (;;) {
    i = skipJsonWhitespace(text, i);
    const key = parseJsonStringLiteral(text, i);
    if (!key) return undefined;
    i = skipJsonWhitespace(text, key.endIndex);
    if (text[i] !== ':') return undefined;
    i = skipJsonWhitespace(text, i + 1);
    const value = parseJsonValue(text, i, depth + 1);
    if (!value) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key.value)) return undefined;
    Object.defineProperty(obj, key.value, {
      value: value.value, enumerable: true, writable: true, configurable: true,
    });
    i = skipJsonWhitespace(text, value.endIndex);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === '}') return { value: obj, endIndex: i + 1 };
    return undefined;
  }
}

function parseJsonArray(text, index, depth) {
  let i = skipJsonWhitespace(text, index + 1);
  const arr = [];
  if (text[i] === ']') return { value: arr, endIndex: i + 1 };

  for (;;) {
    i = skipJsonWhitespace(text, i);
    const value = parseJsonValue(text, i, depth + 1);
    if (!value) return undefined;
    arr.push(value.value);
    i = skipJsonWhitespace(text, value.endIndex);
    if (text[i] === ',') { i += 1; continue; }
    if (text[i] === ']') return { value: arr, endIndex: i + 1 };
    return undefined;
  }
}

function strictParseJson(text) {
  const start = skipJsonWhitespace(text, 0);
  const result = parseJsonValue(text, start, 0);
  if (!result) return undefined;
  const end = skipJsonWhitespace(text, result.endIndex);
  if (end !== text.length) return undefined;
  return { value: result.value };
}

module.exports = {
  utf8ByteLength,
  strictParseJson,
};
