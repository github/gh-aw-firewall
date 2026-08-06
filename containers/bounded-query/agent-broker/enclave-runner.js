'use strict';

// Source-tree resolution shim — NOT shipped in the enclave MCP server image.
//
// The published enclave-mcp-server image receives the real, audited
// bounded-agent enclave modules at /opt/awf/agent-broker (see
// bounded-query/enclave-mcp/Dockerfile, which COPYs
// containers/bounded-agent/broker/ there). This file exists only so the same
// `../agent-broker/enclave-runner` specifier also resolves when the enclave MCP
// modules are required directly from the source tree (unit tests,
// `node --check`), without duplicating a security-critical implementation
// into a second directory.
module.exports = require('../../bounded-agent/broker/enclave-runner');
