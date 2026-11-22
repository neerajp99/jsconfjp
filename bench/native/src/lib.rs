//! The benchmark baseline: the same `imaging::resize_bytes` as the Component, exposed to
//! Node.js as a Node-API addon with napi-rs. Built by `npm run build:native`, which copies
//! the platform's shared library to `bench/imaging.node`.

use napi::bindgen_prelude::*;
use napi_derive::napi;

/// The same `resize_bytes` function as the component, exposed through Node-API.
///
/// JavaScript: `resize(input: Uint8Array, width: number, height: number,
/// format: 'png' | 'jpeg' | 'webp', quality?: number): Buffer`.
///
/// - `input` is borrowed from the JavaScript buffer without a copy.
/// - `quality` applies to `'jpeg'` only and defaults to 80.
/// - Returns the encoded image in a new Node.js `Buffer`.
///
/// # Errors
///
/// Throws a JavaScript `Error` whose message is the Rust error string (`size: ...`,
/// `decode: ...`, `encode: ...`), or `native addon: unknown format ...` for any other
/// `format` string.
#[napi]
pub fn resize(input: &[u8], width: u32, height: u32, format: String, quality: Option<u8>) -> Result<Buffer> {
    let format = match format.as_str() {
        "png" => imaging::Format::Png,
        "webp" => imaging::Format::Webp,
        "jpeg" => imaging::Format::Jpeg(quality.unwrap_or(80)),
        other => {
            return Err(Error::from_reason(format!(
                "native addon: unknown format {other:?}, expected \"png\", \"jpeg\" or \"webp\""
            )))
        }
    };
    imaging::resize_bytes(input, width, height, format)
        .map(Buffer::from)
        .map_err(Error::from_reason)
}
