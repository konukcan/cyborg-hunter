// tools/build-preview-core.mjs
// Bundles src/cli/preview-entry.js (the pure analyzer/renderer/extraction
// subset — see that file's docblock) into demo/preview-core.js, an ESM
// browser bundle the live demo's results screen (demo/results.js) loads via
// dynamic import(). Run via `npm run demo:preview`.
//
// Zero unresolved imports is the empirical gate this whole 0.7.2 extraction
// scope relies on: if a stray Node-only import (fs/path/zlib/...) sneaks in
// transitively through one of preview-entry.js's re-exports, esbuild fails
// the build here rather than shipping a bundle that throws at runtime in the
// browser. platform: 'browser' is what surfaces that failure — it does NOT
// treat Node builtins as external the way platform: 'node' would.

import esbuild from 'esbuild';

async function build() {
  await esbuild.build({
    entryPoints: ['src/cli/preview-entry.js'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: 'demo/preview-core.js',
  });
  console.log('Build complete: demo/preview-core.js');
}

build().catch((e) => {
  console.error('demo:preview build failed — likely a Node-only import (fs/path/zlib/...) reachable from preview-entry.js:');
  console.error(e);
  process.exit(1);
});
