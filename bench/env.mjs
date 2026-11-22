// Shared helpers for the benchmarks: describe the machine and the builds being measured,
// so every set of numbers carries the context needed to interpret it.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';

const root = new URL('../', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, root), 'utf8');

/** Run a command from the repo root and return its first output line, or 'not found'. */
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n')[0];
  } catch {
    return `${cmd}: not found`;
  }
};

/** `key = value` pairs of one TOML table, e.g. `[profile.release]`, as "k=v k=v". */
const tomlTable = (text, table) => {
  const body = text.split(`[${table}]`)[1]?.split(/^\[/m)[0] ?? '';
  return [...body.matchAll(/^\s*([\w-]+)\s*=\s*(.+?)\s*$/gm)].map(([, k, v]) => `${k}=${v.replace(/"/g, '')}`).join(' ');
};

/** Version of a crate as recorded in a Cargo.lock. */
const lockVersion = (lockText, name) => lockText.match(new RegExp(`name = "${name}"\\nversion = "([^"]+)"`))?.[1] ?? '?';

/**
 * SHA-256 (hex) of a file relative to the repo root, or null if it does not exist.
 * @param {string} rel
 * @returns {string | null}
 */
export const sha256 = (rel) => {
  const url = new URL(rel, root);
  return existsSync(url) ? createHash('sha256').update(readFileSync(url)).digest('hex') : null;
};

/**
 * Width and height from a PNG's IHDR chunk.
 * @param {Uint8Array} png
 * @returns {{ width: number, height: number }}
 */
export const pngSize = (png) => {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
};

/**
 * Nearest-rank percentile of an ascending-sorted array.
 * @param {number[]} sorted
 * @param {number} p between 0 and 1
 */
export const percentile = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

/** Print the machine, runtime, toolchain and build flags the numbers below were taken with. */
export function printEnvironment() {
  const osName =
    process.platform === 'darwin'
      ? `macOS ${run('sw_vers', ['-productVersion'])}`
      : process.platform === 'linux' && existsSync('/etc/os-release')
        ? (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]+)/m)?.[1] ?? 'Linux')
        : os.type();
  // Laptops throttle on battery and in Low Power Mode; record both next to the numbers.
  let power = null;
  if (process.platform === 'darwin') {
    const source = run('pmset', ['-g', 'batt']).replace(/^Now drawing from /, '').replace(/'/g, '');
    let lowPower = '';
    try {
      lowPower = execFileSync('pmset', ['-g'], { encoding: 'utf8' }).match(/lowpowermode\s+(\d)/)?.[1] === '1' ? ', Low Power Mode ON' : '';
    } catch {}
    power = source + lowPower;
  }
  const lock = read('bench/native/Cargo.lock');
  const wasmFlags = read('.cargo/config.toml').match(/rustflags\s*=\s*\[(.*)\]/)?.[1].replace(/"/g, '').replace(/,\s*/g, ' ') ?? '';
  const jco = JSON.parse(read('node_modules/@bytecodealliance/jco/package.json')).version;

  console.log('Environment');
  console.log(`  runtime     node ${process.version} (V8 ${process.versions.v8}, Node-API ${process.versions.napi})`);
  console.log(`  os          ${osName}, ${os.type()} ${os.release()}, ${process.arch}${power ? `, power: ${power}` : ''}`);
  console.log(`  cpu         ${os.cpus()[0]?.model ?? 'unknown'}, ${os.availableParallelism()} logical CPUs, ${(os.totalmem() / 2 ** 30).toFixed(0)} GiB RAM`);
  console.log(`  toolchain   ${run('rustc', ['--version'])}; ${run('wasm-tools', ['--version'])}; jco ${jco}; image ${lockVersion(lock, 'image')}; napi ${lockVersion(lock, 'napi')}`);
  const profile = tomlTable(read('Cargo.toml'), 'profile.release');
  const nativeProfile = tomlTable(read('bench/native/Cargo.toml'), 'profile.release');
  console.log(`  profile     [profile.release] ${profile}${nativeProfile === profile ? ' (bench/native/Cargo.toml: same)' : `; bench/native/Cargo.toml differs: ${nativeProfile}`}`);
  console.log(`  wasm flags  ${wasmFlags} (from .cargo/config.toml)`);
  const tuned = sha256('bench/imaging.cpu.node');
  console.log(`  artifacts   dist/imaging.core.wasm ${sha256('dist/imaging.core.wasm')?.slice(0, 16)}…, bench/imaging.node ${sha256('bench/imaging.node')?.slice(0, 16)}…${tuned ? `, bench/imaging.cpu.node ${tuned.slice(0, 16)}…` : ''}`);
  console.log('  each timing is wall clock from performance.now(), on one thread, in the process that made the call');
  console.log();
}
