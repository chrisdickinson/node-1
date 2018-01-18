// This file is mjs and should be parsed as ESM.

try {
  const assert = require('assert');
  throw new Error('.mjs was not short-circuited to the ESM parse goal');
} catch (err) {
  // This error is expected, because require should be unavailable in ESM.
}
