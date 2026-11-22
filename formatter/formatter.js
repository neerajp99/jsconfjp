// A JavaScript component. Its only way to reach the image code is the WIT import.
// componentize-qjs compiles this file, with the QuickJS engine, into formatter.wasm.
import { resize } from 'demo:imaging/resize@0.1.0';

// The QuickJS engine inside this component has no TextEncoder, so encode ASCII by hand.
// (Rust's error strings here are ASCII; other characters would be mangled.)
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0x7f);

export const thumbnails = {
  /**
   * WIT: `thumbnail: func(input: list<u8>, width: u32) -> response`.
   * Inside a component, an imported function is a plain named import (no namespace object).
   * A WIT `result` error is thrown; the error string is read from `err.payload`, with
   * `err.message` as a fallback.
   * @param {Uint8Array} input encoded image
   * @param {number} width box size; the Worker has already checked 1 to 8192
   * @returns {{ status: number, contentType: string, cacheControl: string, body: Uint8Array }}
   */
  thumbnail(input, width) {
    try {
      const body = resize(input, { width, height: width, format: { tag: 'webp' } });
      return {
        status: 200,
        contentType: 'image/webp',
        cacheControl: 'public, max-age=31536000, immutable',
        body,
      };
    } catch (err) {
      return {
        status: 422,
        contentType: 'text/plain',
        cacheControl: 'no-store',
        body: ascii(String(err.payload ?? err.message)),
      };
    }
  },
};
