// Warm resize latency: the same Rust function, `resize_bytes`, built as a Node-API addon,
// optionally as the same addon tuned for this exact CPU, and as the WebAssembly Component,
// all called from one Node thread.
//
// One call = decode a 1920x1280 PNG, Lanczos3 resize to fit 320x320, encode JPEG q80.
// The component also copies the 4.5 MB input into Wasm memory and the result back out;
// the addon reads the input in place and returns Rust's buffer without a copy. Decode and
// resize dominate, so this measures compute, not boundary overhead (bench/cold.mjs covers
// load time and tiny calls).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resize as component } from '../dist/imaging.js';
import { percentile, pngSize, printEnvironment } from './env.mjs';

const require = createRequire(import.meta.url);
const native = require('./imaging.node');
// Built by `npm run build:native:cpu`. Not portable: it may use instructions other CPUs lack.
const tuned = existsSync(new URL('./imaging.cpu.node', import.meta.url)) ? require('./imaging.cpu.node') : null;

const FIXTURE = 'fixtures/photo-1920x1280.png';
const input = readFileSync(new URL(`../${FIXTURE}`, import.meta.url));
const RUNS = Number(process.env.RUNS ?? 30);
const WARMUP = 5;
const BOX = 320;
const QUALITY = 80;

/** @type {Record<string, () => Uint8Array>} */
const cases = {
  'native (Node-API)': () => native.resize(input, BOX, BOX, 'jpeg', QUALITY),
  ...(tuned && { 'native, target-cpu=native (host-tuned)': () => tuned.resize(input, BOX, BOX, 'jpeg', QUALITY) }),
  'component (wasm32 +simd128)': () =>
    component.resize(input, { width: BOX, height: BOX, format: { tag: 'jpeg', val: QUALITY } }),
};
const names = Object.keys(cases);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

printEnvironment();
const { width, height } = pngSize(input);
console.log(`Warm resize latency: ${FIXTURE} (${input.length} bytes, ${width}x${height} PNG) -> fit ${BOX}x${BOX} -> JPEG q${QUALITY}`);

// The builds must agree byte for byte, or the comparison means nothing. Check before timing.
const outputs = names.map((name) => Buffer.from(cases[name]()));
if (!outputs.every((out) => out.equals(outputs[0]))) {
  console.error('bench/resize.mjs: output mismatch between builds. Stopping before any timing.');
  names.forEach((name, i) => console.error(`  ${name}: ${outputs[i].length} bytes, sha256 ${sha(outputs[i])}`));
  console.error('  Timings are only comparable when every build computes the same bytes.');
  console.error('  Known cause on some platforms: the Lanczos3 kernel calls f32::sin, which uses the');
  console.error("  platform libm natively and Rust's bundled libm in Wasm, so weights can differ by 1 ULP.");
  process.exit(1);
}
console.log(`  output check: ${names.length} builds produced identical output, ${outputs[0].length} bytes, sha256 ${sha(outputs[0]).slice(0, 16)}…`);
console.log(`  method: ${WARMUP} warm-up calls, then ${RUNS} timed calls per build, interleaved build by build to spread thermal drift`);

const times = Object.fromEntries(names.map((name) => [name, []]));
for (let i = 0; i < WARMUP; i++) for (const name of names) cases[name]();
for (let i = 0; i < RUNS; i++) {
  for (const name of names) {
    const t0 = performance.now();
    cases[name]();
    times[name].push(performance.now() - t0);
  }
}

const results = {};
for (const name of names) {
  const sorted = times[name].sort((a, b) => a - b);
  results[name] = {
    'median (ms)': +percentile(sorted, 0.5).toFixed(1),
    'p95 (ms)': +percentile(sorted, 0.95).toFixed(1),
    'min (ms)': +sorted[0].toFixed(1),
    'max (ms)': +sorted.at(-1).toFixed(1),
    samples: sorted.length,
  };
}
console.table(results);

/** "1.23x native median (23% slower)" style comparison against the portable native build. */
const compare = (name) => {
  const ratio = results[name]['median (ms)'] / results['native (Node-API)']['median (ms)'];
  const pct = Math.abs((ratio - 1) * 100).toFixed(0);
  return `${name}: ${ratio.toFixed(2)}x native median (${pct}% ${ratio >= 1 ? 'slower' : 'faster'})`;
};
for (const name of names.slice(1)) console.log(compare(name));
