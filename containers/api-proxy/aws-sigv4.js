'use strict';

const crypto = require('crypto');

const SIGNING_HEADER_NAMES = new Set([
  'authorization',
  'host',
  'x-amz-content-sha256',
  'x-amz-date',
  'x-amz-security-token',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
}

function decodeUriComponent(value, label) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error(`Cannot sign AWS request with malformed ${label}`);
  }
}

function canonicalizePath(pathname) {
  if (!pathname) return '/';
  const canonical = pathname
    .split('/')
    .map(segment => encodeRfc3986(decodeUriComponent(segment, 'request path')))
    .join('/');
  return canonical.startsWith('/') ? canonical : `/${canonical}`;
}

function canonicalizeQuery(query) {
  if (!query) return '';
  return query
    .split('&')
    .map(parameter => {
      const separator = parameter.indexOf('=');
      const rawName = separator === -1 ? parameter : parameter.slice(0, separator);
      const rawValue = separator === -1 ? '' : parameter.slice(separator + 1);
      return [
        encodeRfc3986(decodeUriComponent(rawName, 'query string')),
        encodeRfc3986(decodeUriComponent(rawValue, 'query string')),
      ];
    })
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      if (leftValue === rightValue) return 0;
      return leftValue < rightValue ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

function removeSigningHeaders(headers) {
  const unsignedHeaders = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (!SIGNING_HEADER_NAMES.has(name.toLowerCase())) {
      unsignedHeaders[name] = value;
    }
  }
  return unsignedHeaders;
}

function formatAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Sign an AWS request with Signature Version 4.
 *
 * Only the stable AWS-required headers are signed. Other request headers remain
 * intact but outside SignedHeaders so Node can apply its normal transport rules.
 */
function signAwsRequest({
  credentials,
  region,
  service = 'bedrock-runtime',
  method,
  path,
  headers = {},
  body = Buffer.alloc(0),
  targetHost,
  now = new Date(),
}) {
  if (!credentials?.accessKeyId || !credentials?.secretAccessKey || !credentials?.sessionToken) {
    throw new Error('AWS temporary credentials are unavailable');
  }
  if (!region || !targetHost || !method || !path) {
    throw new Error('AWS request signing context is incomplete');
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error('AWS request signing date is invalid');
  }

  const querySeparator = path.indexOf('?');
  const pathname = querySeparator === -1 ? path : path.slice(0, querySeparator);
  const query = querySeparator === -1 ? '' : path.slice(querySeparator + 1);
  const payloadHash = sha256(body);
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date;x-amz-security-token';
  const canonicalHeaders =
    `host:${targetHost.toLowerCase()}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n` +
    `x-amz-security-token:${credentials.sessionToken.trim()}\n`;
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalizePath(pathname),
    canonicalizeQuery(query),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    ...removeSigningHeaders(headers),
    host: targetHost,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-security-token': credentials.sessionToken,
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

module.exports = {
  canonicalizePath,
  canonicalizeQuery,
  signAwsRequest,
};
