// src/cli/update-check.js
// Post-report update nudge, plus the offline collected-with version notice.
//
// The registry check is deliberately zero-dependency and fail-silent: one
// request to npm's registry for the `latest` dist-tag, throttled to once per
// day via a small cache file. A report run must never break, slow down, or
// complain because npm is unreachable. It runs only in the CLI on the
// researcher's machine — the browser library never makes network requests.
//
// Opt-outs (checked before any network or cache access):
//   NO_UPDATE_NOTIFIER — the convention established by update-notifier
//   CI                 — CI runs have no human to nudge

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/cyborg-hunter/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

function defaultCacheFile() {
  return join(homedir(), '.cache', 'cyborg-hunter', 'update-check.json');
}

// Numeric dot-segment comparison ("0.10.0" vs "0.7.2"): returns 1 / 0 / -1 as
// a is newer / equal / older than b. Non-numeric segments count as 0, so a
// malformed registry answer degrades to "no update" rather than a false nudge.
export function compareVersions(a, b) {
  const as = String(a).split('.').map(s => parseInt(s, 10) || 0);
  const bs = String(b).split('.').map(s => parseInt(s, 10) || 0);
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const d = (as[i] || 0) - (bs[i] || 0);
    if (d > 0) return 1;
    if (d < 0) return -1;
  }
  return 0;
}

// Resolves to { latest, updateAvailable } or null (opted out, offline, old
// Node without fetch, or any registry hiccup — all silent by design).
// Everything impure is injectable so tests never touch the network or $HOME.
export async function checkForUpdate({
  currentVersion,
  env = process.env,
  fetchImpl = globalThis.fetch,
  cacheFile = defaultCacheFile(),
  timeoutMs = FETCH_TIMEOUT_MS,
  now = Date.now(),
} = {}) {
  if (env.NO_UPDATE_NOTIFIER || env.CI || typeof fetchImpl !== 'function') return null;

  let cached = null;
  try {
    cached = JSON.parse(readFileSync(cacheFile, 'utf8'));
  } catch { /* no cache yet, or unreadable — fetch below */ }

  let latest;
  if (cached && typeof cached.latest === 'string' &&
      typeof cached.checkedAt === 'number' && now - cached.checkedAt < CHECK_INTERVAL_MS) {
    latest = cached.latest;
  } else {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Never let the timer hold the process open if fetch settles first.
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const res = await fetchImpl(REGISTRY_LATEST_URL, { signal: controller.signal });
      if (!res.ok) return null;
      const body = await res.json();
      if (typeof body.version !== 'string') return null;
      latest = body.version;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ checkedAt: now, latest }));
    } catch { /* unwritable cache dir just means one fetch per run */ }
  }

  return { latest, updateAvailable: compareVersions(latest, currentVersion) > 0 };
}

export function formatUpdateNotice(current, latest) {
  return `Update available: cyborg-hunter ${current} -> ${latest}\n` +
         `  npx picks up new versions automatically; a global install updates with\n` +
         `  npm install -g cyborg-hunter@latest`;
}

// Offline staleness notice: session payloads stamp the library version that
// collected them (monitor.js sets report.libraryVersion), so a mismatch with
// the CLI's own version is detectable with no network at all. This catches
// the case the registry check can't: an experiment still collecting data
// with an old bundle. Returns the notice string, or null when every session
// matches the CLI version (or carries no version, e.g. CSV-derived data).
export function formatCollectedVersionNotice(collectedVersions, cliVersion) {
  const distinct = [...new Set(
    collectedVersions.filter(v => typeof v === 'string' && v.length > 0)
  )].filter(v => v !== cliVersion).sort(compareVersions);
  if (distinct.length === 0) return null;
  return `  Note: sessions in this dataset were collected with cyborg-hunter ` +
         `${distinct.join(', ')}; this CLI is ${cliVersion}.\n` +
         `  Signal definitions and scoring defaults can differ between versions.`;
}
