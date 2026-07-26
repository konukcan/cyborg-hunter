// bench/config.example.js — committed template.
//
// To use bench, copy this file to bench/config.local.js (which is gitignored)
// and fill in your real Roundtable site key. The local file is loaded at run
// time by the harness; the example file is committed only so future contributors
// know the expected shape.
//
//   cp bench/config.example.js bench/config.local.js
//   # edit bench/config.local.js, paste your key
//
// Never commit the real key — bench/.gitignore already excludes config.local.js.

export const ROUNDTABLE_SITE_KEY = 'rt_REPLACE_ME';
