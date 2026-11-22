// Load time, first call and tiny-image latency: where fixed costs, not pixel throughput, decide.
//
// 1. Load time and first call. Each sample is a fresh `node` process that measures:
//    load       component = await import('dist/imaging.js'): read the JS glue and the core
//                           Wasm, compile, instantiate (the bindings use top-level await).
//               native    = require('bench/imaging.node'): dlopen plus Node-API registration.
//    first call one resize right after loading. V8 compiles Wasm lazily by default
//               (--wasm-lazy-compilation), so most compilation happens here, not at load.
// 2. Tiny-image end-to-end latency. Fit a tiny PNG into a box it already fits, many times.
//    Each call still decodes the PNG, copies the pixels (same size, so image skips the
//    resampling) and re-encodes, so this is per-call overhead plus a tiny codec run.
//    It does NOT isolate the JS<->Wasm boundary cost.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { percentile, pngSize, printEnvironment } from './env.mjs';

const require = createRequire(import.meta.url);
const SMALL = 'fixtures/small-640x480.png';
const small = readFileSync(new URL(`../${SMALL}`, import.meta.url));
const FIRST_CALL = { width: 8, height: 8, format: { tag: 'png' } }; // fit 640x480 into 8x8 -> 8x6 PNG

// Child mode: time one load and one first call in this fresh process, print JSON, exit.
if (process.argv[2] === '--load') {
  const t0 = performance.now();
  let t1;
  if (process.argv[3] === 'component') {
    const { resize } = await import('../dist/imaging.js');
    t1 = performance.now();
    resize.resize(small, FIRST_CALL);
  } else {
    const native = require('./imaging.node');
    t1 = performance.now();
    native.resize(small, FIRST_CALL.width, FIRST_CALL.height, 'png');
  }
  console.log(JSON.stringify({ load: t1 - t0, first: performance.now() - t1 }));
  process.exit(0);
}

printEnvironment();

const LOADS = Number(process.env.LOADS ?? 15);
const samples = { component: { load: [], first: [] }, native: { load: [], first: [] } };
for (let i = 0; i < LOADS; i++) {
  for (const which of ['component', 'native']) {
    const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), '--load', which], { encoding: 'utf8' });
    const { load, first } = JSON.parse(out);
    samples[which].load.push(load);
    samples[which].first.push(first);
  }
}

const { resize: component } = await import('../dist/imaging.js');
const native = require('./imaging.node');
const ops = {
  component: { firstCall: () => component.resize(small, FIRST_CALL) },
  native: { firstCall: () => native.resize(small, FIRST_CALL.width, FIRST_CALL.height, 'png') },
};

/** Median wall time in ms of `run` after a warm-up, for comparison with the first call. */
const warmMedian = (run, warmup = 20, n = 50) => {
  for (let i = 0; i < warmup; i++) run();
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    run();
    t.push(performance.now() - t0);
  }
  return percentile(t.sort((a, b) => a - b), 0.5);
};

const stat = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return `median ${percentile(s, 0.5).toFixed(2)} ms (min ${s[0].toFixed(2)}, max ${s.at(-1).toFixed(2)})`;
};
console.log(`Load time and first call: ${LOADS} fresh node processes per build, interleaved; file cache warm after the first run`);
console.log(`  first call = resize ${SMALL} -> fit 8x8 -> PNG immediately after loading; warm = the same call after 20 warm-up calls (median of 50)`);
for (const which of ['component', 'native']) {
  console.log(`  ${which.padEnd(9)} load ${stat(samples[which].load)} | first call ${stat(samples[which].first)} | warm ${warmMedian(ops[which].firstCall).toFixed(2)} ms`);
}
console.log('  component load = read + compile + instantiate with lazy compilation; native load = dlopen + Node-API init');
console.log();

// The tiny input: the small fixture shrunk to fit 8x8 (640x480 keeps its aspect ratio, so 8x6).
const tiny = Buffer.from(component.resize(small, FIRST_CALL));
const { width, height } = pngSize(tiny);
const runComponent = () => component.resize(tiny, { width: 8, height: 8, format: { tag: 'png' } });
const runNative = () => native.resize(tiny, 8, 8, 'png');

if (!Buffer.from(runComponent()).equals(runNative())) {
  console.error('bench/cold.mjs: component and native outputs differ for the tiny image. Stopping before the tiny-image timing.');
  process.exit(1);
}

const WARMUP = 2_000;
const BATCHES = 20;
const PER_BATCH = 1_000;
for (let i = 0; i < WARMUP; i++) {
  runComponent();
  runNative();
}
const batchMeans = { component: [], native: [] };
for (let b = 0; b < BATCHES; b++) {
  for (const [which, run] of [['component', runComponent], ['native', runNative]]) {
    const t0 = performance.now();
    for (let i = 0; i < PER_BATCH; i++) run();
    batchMeans[which].push(((performance.now() - t0) / PER_BATCH) * 1000);
  }
}

console.log(`Tiny-image end-to-end latency: ${width}x${height} PNG (${tiny.length} bytes) -> fit 8x8 -> PNG`);
console.log('  each call decodes the PNG, copies the pixels (same size: no resampling) and re-encodes; NOT a pure boundary-crossing cost');
console.log(`  method: ${WARMUP} warm-up calls each, then ${BATCHES} interleaved batches of ${PER_BATCH} calls; statistic: median of batch means`);
for (const which of ['component', 'native']) {
  const s = batchMeans[which].sort((a, b) => a - b);
  console.log(`  ${which.padEnd(9)} ${percentile(s, 0.5).toFixed(1)} µs/call  (batch means min ${s[0].toFixed(1)}, max ${s.at(-1).toFixed(1)})`);
}
