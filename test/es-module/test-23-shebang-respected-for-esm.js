#!/usr/bin/env node --mode=esm
/*eslint no-unused-vars: ["error", { "varsIgnorePattern": "assert" }]*/

try {
  const assert = require('assert');
  throw new Error('shebang hint of esm mode was not respected');
} catch (err) {
  // This error is expected, because require should be unavailable in ESM.
}
