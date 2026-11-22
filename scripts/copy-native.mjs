// Copy the cdylib that `cargo build` produced in bench/native to a `.node` file that
// Node can require(). Cargo names the library after the platform's convention:
//   Linux and other ELF systems   libimaging_native.so
//   macOS                         libimaging_native.dylib
//   Windows                       imaging_native.dll
// Node does not care about the extension of the source file, only that the
// destination ends in `.node`, so a plain copy is enough.
//
// usage: node scripts/copy-native.mjs <cargo-profile-dir> <destination.node>
// e.g.   node ../../scripts/copy-native.mjs target/release ../imaging.node
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [profileDir, dest] = process.argv.slice(2);
if (!profileDir || !dest?.endsWith('.node')) {
  console.error('copy-native: usage: node scripts/copy-native.mjs <cargo-profile-dir> <destination.node>');
  process.exit(2);
}

const LIBRARY = { darwin: 'libimaging_native.dylib', win32: 'imaging_native.dll' };
const src = join(profileDir, LIBRARY[process.platform] ?? 'libimaging_native.so');
if (!existsSync(src)) {
  console.error(`copy-native: ${src} not found. Check that cargo build --release succeeded in bench/native.`);
  process.exit(1);
}
// Replace, never overwrite in place: macOS caches a signed binary's code signature per file,
// so loading new bytes written into the old inode can get the process killed (exit 137).
rmSync(dest, { force: true });
copyFileSync(src, dest);
console.log(`copy-native: ${src} -> ${dest}`);
