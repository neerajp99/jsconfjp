import { createServer } from 'node:http';
// `resize` is the WIT interface demo:imaging/resize as a namespace object;
// `resize.resize` is the function inside it.
import { resize } from '../dist/imaging.js';

/** Output formats this server accepts in `?fmt=`, and the content type each one returns. */
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_WIDTH = 8192; // same limit as MAX_DIMENSION in src/lib.rs

/**
 * Send a plain-text response. Messages this server writes itself start with "node server:";
 * a 422 body is the Rust error string unchanged.
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
const sendText = (res, status, text) => {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(text);
};

// POST an image to /?w=320&fmt=webp and get the resized image back.
createServer(async (req, res) => {
  // URL.parse returns null instead of throwing, so a malformed request line cannot crash us.
  const url = URL.parse(req.url, 'http://localhost');
  if (!url) return sendText(res, 400, `node server: invalid request URL ${JSON.stringify(req.url)}`);
  // Validate here: the bindings convert numbers with `>>> 0`, so w=-5 would reach Rust as
  // 4294967291 and w=abc as 0.
  const w = url.searchParams.get('w') ?? '320';
  const width = /^\d{1,4}$/.test(w) ? Number(w) : NaN; // digits only: not -5, 0x10 or 1e3
  if (!(width >= 1 && width <= MAX_WIDTH)) {
    return sendText(res, 400, `node server: w must be an integer from 1 to ${MAX_WIDTH}, got "${w}"`);
  }
  const fmt = url.searchParams.get('fmt') ?? 'webp';
  if (!Object.hasOwn(MIME, fmt)) {
    return sendText(res, 400, `node server: fmt must be png, jpeg or webp, got "${fmt}"`);
  }
  const format = fmt === 'jpeg' ? { tag: 'jpeg', val: 80 } : { tag: fmt };

  let input;
  try {
    input = new Uint8Array(await new Response(req).arrayBuffer());
  } catch (err) {
    // The client went away mid-upload. A rejection escaping this async handler would be
    // unhandled and stop the whole server, so answer (if anyone is listening) and move on.
    return sendText(res, 400, `node server: could not read the request body (${err.message})`);
  }
  try {
    const t0 = performance.now();
    // The bindings copy `input` into the component's memory, call the core export with
    // pointers and integers, then copy the result out into a new Uint8Array.
    const output = resize.resize(input, { width, height: width, format });
    res.writeHead(200, {
      'content-type': MIME[fmt],
      'server-timing': `resize;dur=${(performance.now() - t0).toFixed(1)}`,
    });
    res.end(output);
  } catch (err) {
    if (err instanceof WebAssembly.RuntimeError) {
      // A trap, not a Rust error. jco marks the instance as failed, so every later call
      // would fail too; only a restart creates a new one.
      return sendText(res, 500, `node server: the component trapped, restart the server (${err.message})`);
    }
    // A Rust `Err` arrives as jco's ComponentError with the string on err.payload.
    res.writeHead(422, { 'content-type': 'text/plain' });
    res.end(String(err.payload ?? err.message));
  }
}).listen(3000, () => console.log('listening on http://localhost:3000'));
