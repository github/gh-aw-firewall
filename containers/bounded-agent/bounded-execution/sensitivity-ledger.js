'use strict';

// Source-tree resolution shim — NOT shipped in the bounded-agent image.
//
// The published broker image receives the real PR1 bounded-execution
// foundation at /opt/awf/bounded-execution (see bounded-agent/Dockerfile,
// which COPYs containers/bounded-query/bounded-execution/ there). This file
// exists only so the same `../bounded-execution/sensitivity-ledger` specifier
// also resolves when the broker modules are required directly from the source
// tree (unit tests, `node --check`), without duplicating a security-critical
// implementation into a second directory.
module.exports = require('../../bounded-query/bounded-execution/sensitivity-ledger');
