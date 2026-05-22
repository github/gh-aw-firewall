'use strict';

function parsePositiveInteger(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

module.exports = {
  parsePositiveInteger,
};
