// Copyright 2016 the V8 project authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

// Flags: --turbo --always-opt

function f() {
  new Int8Array(new ArrayBuffer(2147483648));
}

// Should not crash
assertThrows(f, RangeError);
