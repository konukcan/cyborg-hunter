// build.js — esbuild configuration for cyborg-hunter.
// Produces five build targets:
//   1. IIFE for <script> tag users (dist/cyborg-hunter.min.js)
//   2. ESM for bundler users (dist/cyborg-hunter.esm.js)
//   3. cyborg-hunter jsPsych extension (dist/extension-cyborg-hunter.js)
//   4. guard-friction extension — deterrence (dist/extension-guard-friction.js)
//   5. guard-honeypot extension — detection  (dist/extension-guard-honeypot.js)
//
// The two guard-extension files are SELF-CONTAINED — each bundles its
// core IIFE plus the jsPsych extension adapter, so a study only loads
// one script per concern. The cyborg-hunter extension still references
// window.CyborgHunter at runtime, so jsPsych users load both
// cyborg-hunter.min.js AND extension-cyborg-hunter.js (keeps the
// standalone core useful for non-jsPsych studies).

import esbuild from 'esbuild';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

async function build() {
  // Browser IIFE — self-contained, exposes window.CyborgHunter.
  // Do NOT manually assign window.CyborgHunter in src/core/index.js;
  // esbuild's globalName handles the global. The footer adds the
  // backward-compat IntegrityMonitor alias.
  await esbuild.build({
    entryPoints: ['src/core/index.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'CyborgHunter',
    outfile: 'dist/cyborg-hunter.min.js',
    platform: 'browser',
    banner: { js: `// cyborg-hunter v${pkg.version} — https://github.com/konukcan/cyborg-hunter` },
    footer: { js: 'if(typeof window!=="undefined")window.IntegrityMonitor=CyborgHunter;' }
  });

  // ESM module
  await esbuild.build({
    entryPoints: ['src/core/index.js'],
    bundle: true,
    format: 'esm',
    outfile: 'dist/cyborg-hunter.esm.js',
    platform: 'browser'
  });

  // cyborg-hunter jsPsych extension — references window.CyborgHunter
  // at runtime, so researcher must load cyborg-hunter.min.js first.
  await esbuild.build({
    entryPoints: ['src/jspsych/extension-cyborg-hunter.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: 'dist/extension-cyborg-hunter.js',
    platform: 'browser'
  });

  // guard-friction extension — self-contained: core IIFE attaches
  // window.GuardFriction; trailing extension class attaches
  // window.jsPsychGuardFriction. Pairs with the honeypot extension.
  await esbuild.build({
    entryPoints: ['src/jspsych/extension-guard-friction.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: 'dist/extension-guard-friction.js',
    platform: 'browser'
  });

  // guard-honeypot extension — self-contained: core IIFE attaches
  // window.GuardHoneypot; trailing extension class attaches
  // window.jsPsychGuardHoneypot. Subscribes to window.GuardFriction
  // .onViolation() if friction is loaded; otherwise still functions
  // as a pure honeypot (empty violation log).
  await esbuild.build({
    entryPoints: ['src/jspsych/extension-guard-honeypot.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: 'dist/extension-guard-honeypot.js',
    platform: 'browser'
  });

  // cyborg-hunter-replay extension — self-contained: bundles the replay
  // core (window.CyborgHunterReplay, standalone-usable) plus the jsPsych
  // adapter (window.jsPsychCyborgHunterReplay). Guard-extension precedent:
  // one script per concern, no load-order dependency on the core dist file.
  await esbuild.build({
    entryPoints: ['src/jspsych/extension-cyborg-hunter-replay.js'],
    bundle: true,
    minify: true,
    format: 'iife',
    outfile: 'dist/cyborg-hunter-replay.js',
    platform: 'browser',
    banner: { js: `// cyborg-hunter-replay v${pkg.version} — https://github.com/konukcan/cyborg-hunter` }
  });

  console.log('Build complete: dist/');
}

build().catch((e) => { console.error(e); process.exit(1); });
