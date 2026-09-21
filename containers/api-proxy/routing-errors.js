'use strict';

const MAX_FAILURE_DETAIL_LENGTH = 500;
const MAX_FAILURE_CODE_LENGTH = 100;

function sanitizeFailureCode(code) {
  const value = typeof code === 'string' ? code : 'routing_configuration_error';
  const sanitized = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .trim()
    .slice(0, MAX_FAILURE_CODE_LENGTH)
    .replace(/[^A-Za-z0-9_.-]/g, '_');
  return sanitized || 'routing_configuration_error';
}

function sanitizeFailureDetail(detail) {
  return String(detail || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, '')
    .slice(0, MAX_FAILURE_DETAIL_LENGTH);
}

class RoutingError extends Error {
  constructor(code, detail) {
    const safeCode = sanitizeFailureCode(code);
    super(sanitizeFailureDetail(detail || safeCode));
    this.name = 'RoutingError';
    this.code = safeCode;
    this.retryable = false;
  }
}

function createRoutingError(code, detail) {
  return new RoutingError(code, detail);
}

function toRoutingFailure(error) {
  const isPublicRoutingError = error instanceof RoutingError;
  const rawCode = isPublicRoutingError ? error.code : 'routing_configuration_error';
  const code = sanitizeFailureCode(rawCode);
  const detail = isPublicRoutingError && typeof error.message === 'string'
    ? error.message
    : 'Model routing failed';
  return Object.freeze({
    schema: 'awf-routing-failure/v1',
    code,
    detail: sanitizeFailureDetail(detail),
    retryable: false,
  });
}

module.exports = {
  RoutingError,
  createRoutingError,
  sanitizeFailureCode,
  sanitizeFailureDetail,
  toRoutingFailure,
};
