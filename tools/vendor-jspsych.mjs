// tools/vendor-jspsych.mjs
// Downloads the pinned jsPsych 7 files the demo's finale (step 10) lazily
// loads at runtime, into demo/vendor/. Run via `npm run demo:vendor`.
//
// Version pin: docs/quickstart.md's unpkg lines pin cyborg-hunter itself
// (@0.7.1) but leave jsPsych unpinned, so per the 0.7.2 demo build plan this
// pins jspsych@7.3.4 directly, plus a compatible @jspsych/plugin-html-
// keyboard-response (peerDependencies: "jspsych": ">=7.1.0", so any current
// release satisfies the 7.3.4 pin — 2.2.0 was latest at pin time).
//
// Offline-safe: demo/vendor/ is gitignored (build artifact, like dist/ and
// preview-core.js), and the demo degrades to a static code panel when it's
// absent (see demo/finale.js). CI runs this with network; local dev may not
// have it, so a failed download prints a clear warning and exits 0 rather
// than failing the build.

import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDOR_DIR = join(__dirname, '..', 'demo', 'vendor');

const FILES = [
  {
    url: 'https://unpkg.com/jspsych@7.3.4/dist/index.browser.js',
    dest: 'jspsych.js',
  },
  {
    url: 'https://unpkg.com/jspsych@7.3.4/css/jspsych.css',
    dest: 'jspsych.css',
  },
  {
    url: 'https://unpkg.com/@jspsych/plugin-html-keyboard-response@2.2.0/dist/index.browser.js',
    dest: 'plugin-html-keyboard-response.js',
  },
];

async function main() {
  mkdirSync(VENDOR_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of FILES) {
    const destPath = join(VENDOR_DIR, file.dest);
    if (existsSync(destPath)) {
      console.log(`  skip  ${file.dest} (already present)`);
      skipped++;
      continue;
    }
    try {
      const res = await fetch(file.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      writeFileSync(destPath, text);
      console.log(`  fetch ${file.dest} <- ${file.url}`);
      downloaded++;
    } catch (e) {
      console.warn(`  WARN  could not download ${file.dest}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\ndemo:vendor — ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  if (failed > 0) {
    console.warn(
      '\n[cyborg-hunter] Some vendor files could not be downloaded (no network?). ' +
      'This is expected for offline local dev — CI runs this step with network ' +
      'access. The demo degrades to a static code panel at step 10 when vendor ' +
      'files are missing; nothing else in the tour depends on them.'
    );
  }
  // Always exit 0 — a missing network is not a build failure locally; the
  // demo's own runtime degradation (demo/finale.js) covers the missing-file
  // case, and CI is expected to have network access.
  process.exit(0);
}

main();
