//! Image resizing as plain Rust, plus the glue that exports it as a WebAssembly Component.
//!
//! [`resize_bytes`] is the whole library and knows nothing about WebAssembly or JavaScript.
//! Two thin wrappers call that one function:
//! - the `component` module below (compiled only for `wasm32`) implements the WIT world
//!   `imaging` from `wit/world.wit`, which `npm run build:component` turns into `imaging.wasm`;
//! - `bench/native/src/lib.rs` exposes it to Node.js as a Node-API addon for the benchmarks.

use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, ImageFormat};
use std::io::Cursor;

/// Largest width or height [`resize_bytes`] accepts for the output bounding box.
///
/// An oversized request never comes back as an `Err`: computing the buffer size panics on
/// overflow, or the allocation fails, and both abort (this release profile sets
/// `panic = "abort"`, and Rust aborts on allocation failure in any profile). In Wasm the abort
/// is a trap that leaves the component instance unusable; in the native addon it kills the
/// whole Node.js process. Rejecting out-of-range sizes up front keeps inputs such as `w=-5`
/// (which JavaScript turns into 4294967291 when it converts to `u32`) on the normal error
/// path. It does not bound memory for every possible input.
pub const MAX_DIMENSION: u32 = 8192;

/// Output encoding for [`resize_bytes`]. Mirrors the WIT variant `format`.
pub enum Format {
    /// Lossless PNG.
    Png,
    /// Baseline JPEG at the given quality. The encoder clamps the value to 1..=100.
    /// JPEG has no alpha channel, so the image is converted to RGB first (alpha is dropped).
    Jpeg(u8),
    /// Lossless WebP (VP8L). The `image` crate's WebP encoder supports lossless only.
    Webp,
}

/// Capability demo only: what one compromised crate in the dependency tree would try.
///
/// Natively this is an ordinary file read with all the permissions of the Node.js process.
/// For `wasm32-unknown-unknown`, Rust's standard library has no filesystem: `read_to_string`
/// returns `Unsupported` without making any call, and the optimizer removes the success
/// branch (the path and the "STOLEN" text are not even in the `.wasm`). Nothing intercepts
/// the read at run time; the component simply has no import that could reach a file.
#[cfg(feature = "evil")]
fn exfiltrate() -> String {
    match std::fs::read_to_string("/tmp/demo-secret.txt") {
        Ok(secret) => format!("STOLEN: {}", secret.trim()),
        Err(e) => format!("blocked: {e}"),
    }
}

/// Decode an encoded image, resize it to fit inside `width` x `height`, and re-encode it.
///
/// Plain Rust. Nothing here knows about WebAssembly or JavaScript.
///
/// - `input`: a complete PNG, JPEG or WebP file; the format is detected from its bytes.
/// - `width`, `height`: the bounding box, each from 1 to [`MAX_DIMENSION`]. The aspect ratio
///   is preserved, so one side usually comes out smaller than requested (640x480 into
///   200x200 gives 200x150). Upscaling is allowed. Resampling uses Lanczos3.
/// - `format`: the output encoding.
///
/// Returns the encoded output file.
///
/// # Errors
///
/// A human-readable message. The component returns it as the WIT `result` error (jco throws
/// it with the text on `err.payload`); the native addon throws it as a JavaScript `Error`.
/// - `size: ...` when `width` or `height` is 0 or larger than [`MAX_DIMENSION`];
/// - `decode: ...` when `input` is empty, truncated, not PNG/JPEG/WebP, or needs more than
///   the decoder's default 512 MiB allocation limit;
/// - `encode: ...` when the encoder fails.
///
/// With the `evil` feature, an empty `input` instead returns the result of the demo's
/// file-read attempt (see `exfiltrate`).
pub fn resize_bytes(input: &[u8], width: u32, height: u32, format: Format) -> Result<Vec<u8>, String> {
    #[cfg(feature = "evil")]
    if input.is_empty() {
        return Err(exfiltrate());
    }
    if !(1..=MAX_DIMENSION).contains(&width) || !(1..=MAX_DIMENSION).contains(&height) {
        return Err(format!("size: width and height must be 1 to {MAX_DIMENSION}, got {width}x{height}"));
    }
    let img = image::load_from_memory(input).map_err(|e| format!("decode: {e}"))?;
    let out = img.resize(width, height, FilterType::Lanczos3);
    let mut buf = Cursor::new(Vec::new());
    match format {
        Format::Png => out.write_to(&mut buf, ImageFormat::Png),
        Format::Webp => out.write_to(&mut buf, ImageFormat::WebP),
        Format::Jpeg(q) => out.to_rgb8().write_with_encoder(JpegEncoder::new_with_quality(&mut buf, q)),
    }
    .map_err(|e| format!("encode: {e}"))?;
    Ok(buf.into_inner())
}

/// The Component glue: implement the WIT world by calling the function above.
///
/// `generate!` reads `wit/world.wit` at compile time and emits the `Guest` trait plus Rust
/// types for the WIT records and variants. `export!` emits the core-Wasm entry point
/// `demo:imaging/resize@0.1.0#resize` and its `cabi_post_...` cleanup; wit-bindgen's runtime
/// adds `cabi_realloc`, which the host calls to allocate guest memory for the input bytes.
/// Together they let the canonical ABI pass `list<u8>` and `result` values as pointers into
/// this module's memory.
#[cfg(target_arch = "wasm32")]
mod component {
    wit_bindgen::generate!({ world: "imaging", path: "wit" });

    use exports::demo::imaging::resize::{Format, Guest, Options};

    struct Component;

    impl Guest for Component {
        /// WIT: `resize: func(input: list<u8>, opts: options) -> result<list<u8>, string>`.
        /// By the time this runs, the bindings have already copied `input` into this module's
        /// memory; the returned bytes are copied out by the host after it returns.
        fn resize(input: Vec<u8>, opts: Options) -> Result<Vec<u8>, String> {
            let format = match opts.format {
                Format::Png => super::Format::Png,
                Format::Jpeg(q) => super::Format::Jpeg(q),
                Format::Webp => super::Format::Webp,
            };
            super::resize_bytes(&input, opts.width, opts.height, format)
        }
    }

    export!(Component);
}
