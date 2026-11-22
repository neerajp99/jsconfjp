// Workers cannot compile Wasm at runtime, so every core module must be a static import.
// This writes worker/src/modules.js with one import per .wasm file that jco emitted,
// and fails if the generated bindings ask for a module that is not in the map.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const files = readdirSync('worker/dist').filter((f) => f.endsWith('.wasm')).sort();
const imports = files.map((f, i) => `import m${i} from '../dist/${f}';`).join('\n');
const table = files.map((f, i) => `  '${f}': m${i},`).join('\n');
writeFileSync('worker/src/modules.js', `${imports}\n\nexport const modules = {\n${table}\n};\n`);

// jco's async instantiation calls getCoreModule('<file>') once per core module it needs.
const wanted = [...readFileSync('worker/dist/thumbnailer.js', 'utf8').matchAll(/getCoreModule\('([^']+)'\)/g)].map((m) => m[1]);
const missing = wanted.filter((name) => !files.includes(name));
if (wanted.length === 0 || missing.length) {
  console.error(`worker-modules: bindings request [${missing.join(', ') || 'no getCoreModule calls found'}]; the map cannot be checked or is incomplete`);
  process.exit(1);
}
console.log(`worker/src/modules.js: ${files.length} static Wasm imports, all ${wanted.length} modules the bindings request are present`);
