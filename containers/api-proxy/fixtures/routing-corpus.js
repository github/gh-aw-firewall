'use strict';

// Responses recorded from githubnext/gh-aw-router. Refreshing means taking a new
// export from that repo; never edit a case to make a test pass. A case names the
// routing tables it was recorded against, and that repo owns those tables.

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const corpusRoot = path.join(__dirname, 'routing-contract');

const corpusCases = JSON.parse(readFileSync(path.join(corpusRoot, 'cases.json')));

function corpusCase(id) {
  const testCase = corpusCases.find(entry => entry.id === id);
  assert.ok(testCase, `Router corpus case is missing: ${id}`);
  return testCase;
}

module.exports = { corpusCase, corpusCases };
