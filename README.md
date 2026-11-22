# never-compile

Demo for "npm install Should Never Compile: Killing Native Addons" (JSConf JP 2026).

One Rust function (`resize_bytes` in `src/lib.rs`, built on the `image` crate) is compiled once
for WebAssembly. The resulting core module runs byte for byte unchanged in Node.js and Bun
(through `imaging.wasm`'s generated bindings) and in a Cloudflare Worker (inside the composed
`thumbnailer.wasm`). The npm package in `pkg/` needs no node-gyp, no prebuild matrix and no
install script. The build tools themselves still ship platform binaries.

Code blocks below contain commands only, so they can be pasted into any shell (zsh without
`interactivecomments` would treat a trailing `# ...` as arguments).

## Prerequisites

- **rustup**, plus a C toolchain that provides `cc` (Xcode Command Line Tools on macOS,
  build-essential on Linux). Rust links build scripts and proc-macros with it, even for the
  Wasm target. `rust-toolchain.toml` pins Rust 1.97.1 with the `wasm32-unknown-unknown` target,
  and rustup installs both on the first `cargo` command inside the repo. Older toolchains fail
  with "lock file version `4` was found".
- **wasm-tools and wac.** Run this from the repo root, so that `rust-toolchain.toml` selects
  1.97.1 (or use `cargo +1.97.1 install ...` elsewhere):

  ```sh
  cargo install --locked wasm-tools@1.263.0 wac-cli@0.12.0
  ```

- **Node.js 26.** npm 12.2.2 supports Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`. On older
  versions it still works but prints `npm warn cli npm v12.2.2 does not support Node.js ...`.
- **Python 3 and a C++ compiler**, only for node-gyp in the cold open's older-npm path.

Install the JavaScript tools exactly as locked:

```sh
npx -y npm@12.2.2 ci
```

npm 12 skips dependency install scripts unless `package.json` approves them. Four packages in
the dev dependency tree have one: `bun` (a direct dev dependency) and `esbuild`, `workerd` and
`fsevents` (through wrangler). The `allowScripts` field approves `bun@1.4.4`, whose postinstall
links the platform binary; without it, `bun` exits with "Bun's postinstall script was not run".
It denies the other three, which work without their scripts. Older npms install this lockfile
too: npm 11.20.0 already honours `allowScripts` the same way, while npm 10.9.4 ignores the field
and runs all four scripts.

## Rehearse from a clean checkout

A checkout contains sources only. Run these in order from the repo root:

```sh
npx -y npm@12.2.2 ci
npm run build:component
npm run build:bindings
npm run build:formatter
npm run build:compose
npm run build:worker
npm run build:pkg
npm run build:native
npm run build:native:cpu
npm run build:evil
```

| Script | Produces |
| --- | --- |
| `build:component` | `imaging.wasm`, a Component with one export and zero imports (cargo, then `wasm-tools component new`) |
| `build:bindings` | `dist/`: `imaging.js`, `imaging.core.wasm` and `.d.ts` files (`jco transpile`) |
| `build:formatter` | `formatter.wasm`, the JavaScript formatter with QuickJS inside (componentize-qjs) |
| `build:compose` | `thumbnailer.wasm` (`wac plug` formatter + imaging) |
| `build:worker` | `worker/dist/` and `worker/src/modules.js` (jco for Workers + static Wasm imports) |
| `build:pkg` | `pkg/dist/`, a copy of `dist/` |
| `build:native` | `bench/imaging.node`, the Node-API benchmark baseline |
| `build:native:cpu` | optional: `bench/imaging.cpu.node`, tuned for this CPU only |
| `build:evil` | the capability demo: `imaging.evil.wasm`, `evil/dist/`, `bench/imaging.evil.node` |
| `build:coldopen` | rebuilds the checked-in `coldopen/native-hello/native-hello-1.0.0.tgz`; only needed after editing `coldopen/native-hello` |

All of these outputs are gitignored, except the cold-open tarball.

## The component and its three hosts

```sh
wasm-tools component wit imaging.wasm
npm start
```

In a second terminal:

```sh
curl -sS -D - -o out.webp --data-binary @fixtures/small-640x480.png 'http://localhost:3000/?w=200&fmt=webp'
curl -sS -i --data-binary 'not an image' 'http://localhost:3000/?w=200'
npm run test:bun
npm run dev:worker
```

And in a third:

```sh
curl -sS -D - -o worker.webp --data-binary @fixtures/small-640x480.png 'http://localhost:8787/?w=200'
```

What you should see:

- `wasm-tools`: `world root { export demo:imaging/resize@0.1.0; }` and no imports.
- Node.js: `HTTP/1.1 200 OK`, `content-type: image/webp`, and a 28,810-byte WebP of 200x150
  (`w` is a box, and 640x480 keeps its 4:3 aspect ratio). The bad input gets `422` and
  `decode: The image format could not be determined`.
- Bun: `3 pass`, `0 fail`.
- Worker: `200`, `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable`,
  and the same 28,810 bytes as the Node.js server. A bad input gets `422`, `text/plain` and
  `Cache-Control: no-store`.

`?w=` must be a whole number (digits only) from 1 to 8192, and `?fmt=` (Node.js only) one of
`png`, `jpeg` or `webp`. Anything else gets a `400` from the server or Worker before the
component is called.

### How the pieces connect

- **Two names in `resize.resize()`.** jco exposes each exported WIT *interface* as a namespace
  object. The first `resize` is the interface `demo:imaging/resize`, the second is the function
  inside it. Inside the formatter component the import is a plain named function, `resize(...)`.
- **Bytes across the boundary.** The generated `dist/imaging.js` asks the guest to allocate
  (`cabi_realloc`), copies the input into Wasm memory, and calls the core export with six
  integers: pointer, length, width, height, format tag and quality. The result comes back as a
  pointer to a small record in Wasm memory. The bindings copy the bytes out
  (`memory.buffer.slice`), let the guest free its buffer (`cabi_post_...`), and either return
  the `Uint8Array` or throw the error string.
- **A Rust error is a value, a trap is not.** An `Err` from `resize_bytes` arrives as a thrown
  jco `ComponentError` with the string on `err.payload`, and the instance keeps working. A trap
  (a Rust panic or a failed allocation, both of which abort in this build) marks the instance
  as failed, and every later call throws `wasm trap: cannot enter component instance`. The
  server reports this as a 500 and needs a restart. The Worker drops the instance so the next
  request makes a new one.
- **`wac plug`.** The formatter's world imports `demo:imaging/resize` and exports
  `demo:imaging/thumbnails`. `wac plug formatter.wasm --plug imaging.wasm` embeds both
  components in `thumbnailer.wasm`, instantiates imaging first, and passes its `resize` export
  as the formatter's import. The result imports nothing (`wasm-tools component wit thumbnailer.wasm`).
- **Static imports in the Worker.** Workers do not compile WebAssembly from bytes at run time
  (workerd: "Wasm code generation disallowed by embedder"). `jco transpile --instantiation async`
  emits an `instantiate(getCoreModule, imports)` function instead of fetching `.wasm` files.
  `scripts/worker-modules.mjs` writes one static import per core module into
  `worker/src/modules.js`, so Wrangler uploads them as precompiled modules. It fails the build
  if the bindings request a module that is not in the map (15 of 15 today).

### Where a message comes from

| Text starts with | Produced by |
| --- | --- |
| `npm warn install-scripts`, `npm error` | npm |
| `Error: Cannot find module './build/Release/hello.node'` | Node.js's module loader: the cold open's addon was never compiled |
| `decode:`, `encode:`, `size:` | Rust `resize_bytes`. A WIT `result` error in the component, an `Error` in the native addon |
| `STOLEN:`, `blocked:` | Rust, the capability demo's `evil` code |
| `wasm trap:`, `invalid variant tag value` | jco's generated bindings: a trap, or a JS value the WIT type rejects |
| `node server:` | `node/server.mjs` |
| `worker:` | `worker/src/index.js` |
| `native addon:` | `bench/native/src/lib.rs` |
| `test:` | helpers in `bun/resize.test.ts` |
| `bench/resize.mjs:`, `bench/cold.mjs:`, `copy-native:`, `worker-modules:`, `evil/steal.mjs:` | this repo's scripts |

## Which bytes are identical

```sh
shasum -a 256 imaging.wasm thumbnailer.wasm dist/imaging.core.wasm worker/dist/thumbnailer.core.wasm
```

The last two hashes match: they are the same compiled Rust **core module**. Node.js and Bun
load `dist/imaging.core.wasm` (one `WebAssembly.compile` of exactly those bytes), and the
Worker bundle carries the identical module as `thumbnailer.core.wasm`. The two Components
differ, as they should:

- `imaging.wasm`, the **source Component**, is that core module plus its WIT type information.
- `thumbnailer.wasm`, the **composed Component**, embeds `imaging.wasm` byte for byte next to
  the formatter. jco splits it into 15 core modules: the Rust one, the formatter's eleven (the
  QuickJS engine is the 1,166,247-byte `thumbnailer.core4.wasm`), and three adapters that jco
  generates.
- `target/wasm32-unknown-unknown/release/imaging.wasm`, the raw `cargo` output, differs too:
  `wasm-tools component new` removes its `component-type` section and adds `producers` data.

No host runs a Component binary directly. jco turns each one into core modules plus JavaScript
glue, and the glue differs between the two builds.

`formatter.wasm`, and so `thumbnailer.wasm`, get a new hash on every build even when nothing
changed: componentize-qjs snapshots the QuickJS heap, and that snapshot is not deterministic
(same size, different bytes). The Rust core module is reproducible: rebuilding it gives the
same hash.

The hashes are stable for one machine, not across machines. Release builds keep panic-location
strings such as `/Users/<you>/.cargo/registry/src/...`, so the bytes depend on your home
directory, and the published `.wasm` contains your user name. For a path-independent build:

```sh
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS="--remap-path-prefix=$HOME=~" npm run build:component
```

Cargo combines that variable with `.cargo/config.toml`, so `+simd128` stays on.

## The npm package

```sh
npm run build:pkg
(cd pkg && npx -y npm@12.2.2 pack)
```

`pkg/` is what a user installs: `dist/imaging.js`, `dist/imaging.core.wasm`, `dist/imaging.d.ts`,
`dist/interfaces/demo-imaging-resize.d.ts` and `package.json`. There is no `binding.gyp`, no
install script and no per-platform binary. Try it outside the repo (start in the repo root):

```sh
REPO="$PWD"
rm -rf /tmp/consumer && mkdir /tmp/consumer && cd /tmp/consumer
npx -y npm@12.2.2 init -y
npx -y npm@12.2.2 pkg set type=module
npx -y npm@12.2.2 install "$REPO/pkg/demo-imaging-0.1.0.tgz"
cp "$REPO/fixtures/small-640x480.png" input.png
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { resize } from '@demo/imaging';
const out = resize.resize(readFileSync('input.png'), { width: 160, height: 160, format: { tag: 'png' } });
console.log(out.length, 'bytes');"
cd "$REPO"
```

The install prints no install-scripts warning, and the script prints `26642 bytes`.

## Benchmarks

```sh
npm run build:native
npm run build:native:cpu
npm run bench
```

`build:native` is required; `build:native:cpu` is optional and adds a separately labelled
host-tuned column. `npm run bench` runs `bench/resize.mjs`, then `bench/cold.mjs`. Each first
prints the environment: Node.js and V8 versions, OS, CPU, power source and Low Power Mode
(macOS), rustc, wasm-tools, jco, crate versions, both release profiles, the Wasm flags
(`+simd128`) and the hashes of the artifacts being measured.

- **Warm resize latency** (`bench/resize.mjs`): `fixtures/photo-1920x1280.png` resized to fit
  320x320 and encoded as JPEG q80. Every call decodes the PNG, resizes with Lanczos3 and encodes
  the JPEG. The component's calls also copy the 4.5 MB input into Wasm memory and the result
  back out; the addon reads the input in place and hands Rust's buffer to JavaScript without a
  copy. 5 warm-up calls, then `RUNS` (default 30) timed calls per build, interleaved. Reports
  median, p95, min and max in ms. It first checks that every build returns identical bytes and
  **exits with status 1 before any timing if they differ**.
- **Load time and first call** (`bench/cold.mjs`): `LOADS` (default 15) fresh `node` processes
  per build. The component's load is `await import('dist/imaging.js')`, the addon's is
  `require('bench/imaging.node')`. V8 compiles Wasm lazily, so most compilation lands in the
  first call (small fixture to fit 8x8, a real resample), which is reported separately next to
  the same call when warm.
- **Tiny-image end-to-end latency** (`bench/cold.mjs`): an 8x6 PNG (the small fixture fitted
  into 8x8) fitted into 8x8 again, 20 interleaved batches of 1,000 calls. Reports the median of
  the batch means in µs per call. Each call decodes the PNG, copies the pixels (same size, so
  no resampling) and re-encodes. That is per-call overhead plus a tiny codec run, **not** the
  boundary cost alone.

Byte-identical output is not guaranteed across targets. The Lanczos3 kernel calls `f32::sin`,
which uses the platform libm natively and Rust's own libm in Wasm. On macOS arm64 the two
disagree by 1 ULP for about 7% of the kernel's inputs, so most PNG and WebP outputs, and the
small fixture as a 200 px JPEG, differ by a few bytes. The benchmark's case (the photo as a
320 px JPEG q80) is identical there. Plug the laptop in and turn Low Power Mode off before
measuring.

## Versions this was checked with

macOS 14.1.2 on an Apple M2 Pro (arm64), with Node.js 26.13.1 (bundled npm 11.20.0) and
Node.js 22.22.0 (bundled npm 10.9.4). npm 12.2.2, 12.2.3 and 11.21.3 via `npx`. Rust 1.97.1,
wasm-tools 1.263.0, wac-cli 0.12.0, jco 1.41.0, componentize-qjs 0.5.0, Bun 1.4.4,
Wrangler 4.160.0 (workerd 2026-11-10), and TypeScript 7.0.2 for the consumer type check.
The Worker ran locally under workerd (`wrangler dev`) and was bundled with
`wrangler deploy --dry-run`; it has not been deployed. Linux was not tested. There,
`scripts/copy-native.mjs` copies `libimaging_native.so`, as the old `cp` step did.

## The cold open

`coldopen/native-hello` is a four-file node-gyp addon (`package.json`, `binding.gyp`, `hello.cc`,
`index.js`), packed as `native-hello-1.0.0.tgz`. Its `package.json` has no scripts, but because
it ships a `binding.gyp`, npm gives it an implicit `install: node-gyp rebuild`. The tarball
contains no compiled `.node` file. `coldopen/app` depends on the tarball.

Run each npm in its own copy, starting in the repo root. First an older npm, whose install
script compiles `hello.cc` on this machine:

```sh
REPO="$PWD"
rm -rf /tmp/co-old && cp -R "$REPO/coldopen" /tmp/co-old
(cd /tmp/co-old/app && npx -y npm@11.21.3 install --foreground-scripts)
(cd /tmp/co-old/app && node -p "require('native-hello')()")
```

Expect node-gyp's `CXX(target) ...`, `SOLINK_MODULE(target) Release/hello.node` and
`gyp info ok`, exit status 0, then `hello`. Then npm 12, which installs, skips the unapproved
script and says so:

```sh
REPO="$PWD"
rm -rf /tmp/co-12 && cp -R "$REPO/coldopen" /tmp/co-12
(cd /tmp/co-12/app && npx -y npm@12.2.2 install)
(cd /tmp/co-12/app && node -e "require('native-hello')")
(cd /tmp/co-12/app && npx -y npm@12.2.2 install-scripts ls)
```

```text
npm warn install-scripts 1 package had install scripts blocked because they are not covered by allowScripts:
npm warn install-scripts   native-hello@1.0.0 (install: node-gyp rebuild)
Error: Cannot find module './build/Release/hello.node'
```

The install exits 0 and the `require` exits 1. Without `--foreground-scripts`, npm 10 and 11
hide node-gyp's output and print only `added 1 package`. npm 11.20 and later also warn that the
script is "not yet covered by allowScripts", but still run it. Always use `npx -y` with an exact
version: in a terminal, plain `npx npm@12` stops to ask before downloading npm, and it resolves
to the newest 12.x (12.2.3 since 2026-11-18).

## Capability demo: the same malicious lines, two targets

`src/lib.rs` has an opt-in `evil` feature. It simulates one compromised crate in the
dependency tree: when `resize_bytes` receives an empty input, it tries to read
`/tmp/demo-secret.txt` and returns what it found.

```sh
npm run build:evil
npm run demo:evil
```

Expected output:

```text
native addon : STOLEN: hunter2
component    : blocked: operation not supported on this platform
```

`evil/steal.mjs` writes the canary (`hunter2`) only if no such file exists (it refuses to
overwrite one) and always deletes it afterwards, so it exists only while the demo runs.

What this shows, precisely: the native addon runs inside the Node.js process with all of its
permissions, so the read succeeds. The component's world still has one export and no imports
(`wasm-tools component wit imaging.evil.wasm`). Nothing intercepted the read at run time:
for `wasm32-unknown-unknown`, Rust's standard library has no filesystem, so `read_to_string`
returns "operation not supported on this platform" without making any call. The optimizer
even removed the path and the `STOLEN` branch from the `.wasm`. The host has the file and could
read it; the guest has no import through which to ask.

This is a property of *this* import-free component, not of every Wasm build. A component that
imports `wasi:filesystem` can read whatever directories its host chooses to provide. And the
JavaScript glue jco generates runs with the full authority of the Node.js process.
