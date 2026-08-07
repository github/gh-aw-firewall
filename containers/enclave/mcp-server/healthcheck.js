'use strict';

const fs = require('fs');
const { READY_PATH } = require('./config');

try {
  fs.accessSync(READY_PATH, fs.constants.F_OK);
  process.exit(0);
} catch {
  process.exit(1);
}
