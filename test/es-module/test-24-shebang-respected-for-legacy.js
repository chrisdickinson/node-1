#!../../node --mode legacy
'use strict';

if (typeof this === 'undefined') {
  throw new Error('shebang hint of legacy mode was not respected');
}
