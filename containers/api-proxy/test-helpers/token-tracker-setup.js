'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const tokenLogDir = process.env.AWF_TOKEN_LOG_DIR
  || fs.mkdtempSync(path.join(os.tmpdir(), 'token-tracker-test-'));
process.env.AWF_TOKEN_LOG_DIR = tokenLogDir;

module.exports = { tokenLogDir };
