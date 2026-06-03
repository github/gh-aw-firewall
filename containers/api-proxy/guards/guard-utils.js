'use strict';

function parsePositiveInteger(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return parsed;
}

function parseModelMultipliers(raw) {
  if (!raw || String(raw).trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const result = {};
    for (const [model, value] of Object.entries(parsed)) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) {
        result[model] = num;
      }
    }
    return result;
  } catch {
    return {};
  }
}

function parsePositiveNumber(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
  parsePositiveInteger,
  parseModelMultipliers,
  parsePositiveNumber,
};
