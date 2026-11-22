import { instantiate } from '../dist/thumbnailer.js';
// Workers will not compile WebAssembly from bytes at run time. Every core module has to be
// part of the uploaded bundle as a static import, which Wrangler hands to the Worker as an
// already compiled WebAssembly.Module. scripts/worker-modules.mjs generates this map.
import { modules } from './modules.js';

const MAX_WIDTH = 8192; // same limit as MAX_DIMENSION in src/lib.rs

let component; // instantiated once per isolate, reused across requests

/**
 * Plain-text response for errors the Worker itself reports. These start with "worker:".
 * @param {number} status
 * @param {string} text
 */
const workerError = (status, text) =>
  new Response(`worker: ${text}`, { status, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });

export default {
  /**
   * POST an image to /?w=320 and get a WebP thumbnail that fits a w x w box.
   * @param {Request} request
   * @returns {Promise<Response>}
   */
  async fetch(request) {
    const w = new URL(request.url).searchParams.get('w') ?? '320';
    const width = /^\d{1,4}$/.test(w) ? Number(w) : NaN; // digits only: not -5, 0x10 or 1e3
    if (!(width >= 1 && width <= MAX_WIDTH)) {
      return workerError(400, `w must be an integer from 1 to ${MAX_WIDTH}, got "${w}"`);
    }
    const input = new Uint8Array(await request.arrayBuffer());

    // No WASI shim: the composed component imports nothing, so the import object is empty.
    // Taken after the last await above, so no other request can discard it before the call.
    component ??= await instantiate((name) => modules[name], {});

    // One call crosses JS -> the JavaScript formatter component -> the Rust image component.
    let r;
    try {
      r = component.thumbnails.thumbnail(input, width);
    } catch (err) {
      // A Rust error comes back as a 422 response from the formatter, not as an exception.
      // An exception here is a trap, and a trapped instance refuses every later call:
      // drop it so the next request in this isolate instantiates a fresh one.
      component = undefined;
      return workerError(500, `the component trapped and was discarded (${err.message})`);
    }
    return new Response(r.body, {
      status: r.status,
      headers: { 'content-type': r.contentType, 'cache-control': r.cacheControl },
    });
  },
};
