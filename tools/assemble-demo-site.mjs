// tools/assemble-demo-site.mjs
// Assembles the same artifact the Pages CI workflow builds — demo/* at site
// root + dist/ — into .demo-site/ (gitignored), so the Playwright suite runs
// against something that behaves like the deployed site instead of the bare
// demo/ directory (whose index.html expects ./dist/... next to it). This is
// also the single source of assembly logic: the Pages CI workflow calls this
// same script rather than duplicating the copy step.
//
// Steps:
//   1. `node build.js` -> dist/ (skipped if dist/ is newer than every file
//      under src/ — "if stale" per the plan).
//   2. `node tools/build-preview-core.mjs` -> demo/preview-core.js.
//   3. Copy demo/* (excluding demo/tests/ — Playwright specs must not ship
//      in the public artifact) and dist/ into .demo-site/.
//
// Usage: node tools/assemble-demo-site.mjs

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SITE_DIR = join(ROOT, '.demo-site');
const DEMO_DIR = join(ROOT, 'demo');

// Excludes demo/tests/ (Playwright specs + helpers — dev-only, must not ship
// publicly). Everything else under demo/ is runtime: index.html, demo.css,
// the *.js modules, signal-manifest.json, assets/.
function isRuntimeFile(src) {
  const rel = relative(DEMO_DIR, src);
  return rel !== 'tests' && !rel.startsWith('tests' + sep);
}

function newestMtimeUnder(dir) {
  var newest = 0;
  for (var entry of readdirSync(dir, { withFileTypes: true })) {
    var full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtimeUnder(full));
    } else {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}

function distIsStale() {
  var marker = join(ROOT, 'dist', 'cyborg-hunter.min.js');
  if (!existsSync(marker)) return true;
  var distMtime = statSync(marker).mtimeMs;
  return newestMtimeUnder(join(ROOT, 'src')) > distMtime;
}

function run(label, cmd, args) {
  console.log('assemble-demo-site: ' + label);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

function main() {
  if (distIsStale()) {
    run('building dist/ (stale)', process.execPath, ['build.js']);
  } else {
    console.log('assemble-demo-site: dist/ is up to date, skipping build.js');
  }

  run('building demo/preview-core.js', process.execPath, ['tools/build-preview-core.mjs']);

  rmSync(SITE_DIR, { recursive: true, force: true });
  mkdirSync(SITE_DIR, { recursive: true });
  cpSync(DEMO_DIR, SITE_DIR, { recursive: true, filter: isRuntimeFile });
  cpSync(join(ROOT, 'dist'), join(SITE_DIR, 'dist'), { recursive: true });

  console.log('assemble-demo-site: assembled ' + SITE_DIR);
}

main();
