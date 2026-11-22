import { describe, expect, test } from 'bun:test';
// The same dist/ that Node.js loads: jco's ES module, its .d.ts and the core Wasm. No rebuild.
import { resize } from '../dist/imaging.js';

const input = new Uint8Array(await Bun.file('fixtures/small-640x480.png').arrayBuffer());

/** Width and height from a lossless WebP (VP8L) header: 14 bits each, stored minus one. */
function webpSize(b: Uint8Array): [number, number] {
  const bits = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(21, true);
  return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
}

/** Width and height from the first baseline/progressive JPEG start-of-frame segment. */
function jpegSize(b: Uint8Array): [number, number] {
  for (let i = 2; i + 8 < b.length; i += 2 + ((b[i + 2] << 8) | b[i + 3])) {
    if (b[i] !== 0xff) throw new Error(`test: expected a JPEG marker at byte ${i}`);
    if (b[i + 1] >= 0xc0 && b[i + 1] <= 0xc2) return [(b[i + 7] << 8) | b[i + 8], (b[i + 5] << 8) | b[i + 6]];
  }
  throw new Error('test: no JPEG start-of-frame segment');
}

const ascii = (b: Uint8Array, from: number, to: number) => new TextDecoder().decode(b.slice(from, to));

describe('imaging component under Bun', () => {
  test('resizes to WebP', () => {
    const out = resize.resize(input, { width: 200, height: 200, format: { tag: 'webp' } });
    expect(ascii(out, 0, 4)).toBe('RIFF');
    expect(ascii(out, 8, 16)).toBe('WEBPVP8L'); // lossless WebP
    expect(webpSize(out)).toEqual([200, 150]); // 640x480 fitted into 200x200 keeps 4:3
  });

  test('resizes to JPEG with a quality', () => {
    const jpeg = (val: number) => resize.resize(input, { width: 200, height: 200, format: { tag: 'jpeg', val } });
    const out = jpeg(80);
    expect([out[0], out[1]]).toEqual([0xff, 0xd8]);
    expect(jpegSize(out)).toEqual([200, 150]);
    expect(jpeg(30).length).toBeLessThan(jpeg(90).length); // the quality reaches the encoder
  });

  test('a WIT result error arrives as a thrown ComponentError', () => {
    const tryResize = (bytes: Uint8Array, width: number): unknown => {
      try {
        resize.resize(bytes, { width, height: width, format: { tag: 'png' } });
      } catch (err) {
        return err;
      }
      throw new Error('test: expected resize to throw');
    };
    // The Rust Err string is the message and, as jco's ComponentError, also err.payload.
    const decode = tryResize(new Uint8Array([1, 2, 3]), 10) as Error & { payload?: unknown };
    expect(decode).toBeInstanceOf(Error);
    expect(decode.payload).toStartWith('decode: ');
    expect(decode.message).toBe(decode.payload as string);
    expect((tryResize(input, 0) as Error).message).toStartWith('size: ');
    // A result error is a value, not a trap: the same instance keeps working.
    expect(resize.resize(input, { width: 10, height: 10, format: { tag: 'png' } })).toBeInstanceOf(Uint8Array);
  });
});
