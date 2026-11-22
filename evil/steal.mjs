// Capability demo. The SAME Rust source, with the SAME extra lines that try to read a file,
// built two ways: as a Node-API addon and as an import-free WebAssembly Component.
// Build both first with `npm run build:evil`.
import { createRequire } from 'node:module';
import { rmSync, writeFileSync } from 'node:fs';
import { resize } from './dist/imaging.js';

// Must match the path hard-coded in `exfiltrate()` in src/lib.rs (the `evil` feature).
const CANARY = '/tmp/demo-secret.txt';

const native = createRequire(import.meta.url)('../bench/imaging.evil.node');
const empty = new Uint8Array(0); // the trigger: an empty input

/**
 * Run one resize call and return the text it failed with.
 * Both builds report through their normal error path: the addon throws an Error whose
 * message is the Rust `Err` string; the component throws jco's ComponentError, whose
 * `payload` is the WIT `result` error string.
 * @param {() => unknown} call
 * @returns {string}
 */
const attempt = (call) => {
  try {
    call();
    return 'no error (is this the evil build? run npm run build:evil)';
  } catch (err) {
    return String(err.payload ?? err.message);
  }
};

// The canary ("hunter2") exists only while this script runs. 'wx' creates it only if
// nothing is there, so a real file is never overwritten.
try {
  writeFileSync(CANARY, 'hunter2\n', { flag: 'wx' });
} catch (err) {
  if (err.code !== 'EEXIST') throw err;
  console.error(`evil/steal.mjs: ${CANARY} already exists. Not overwriting it; delete it if an earlier run left it behind.`);
  process.exit(1);
}

try {
  console.log('native addon :', attempt(() => native.resize(empty, 1, 1, 'png')));
  console.log('component    :', attempt(() => resize.resize(empty, { width: 1, height: 1, format: { tag: 'png' } })));
} finally {
  rmSync(CANARY, { force: true });
}
