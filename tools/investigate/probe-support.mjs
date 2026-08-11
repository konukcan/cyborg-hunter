// tools/investigate/probe-support.mjs
//
// Shared apparatus for the T5 Task-0 investigation probes
// (canvas-presentation-probe.mjs, seek-latency-baseline.mjs).
//
// Nothing in here is product code. It exists so the two probes agree on how
// they resolve a browser, how they read pixels, which CSP string they test
// under, and how they reduce samples — three of which are the exact places
// the T5 plan review found a probe telling itself a comfortable story.
//
// Four pieces:
//
//   resolvePlaywright / launchEngines
//       Same three-candidate order as tests/browser/replay/cursor-alignment
//       .battery.mjs, PLAYWRIGHT_CORE_DIR first. The plan review (M-3)
//       established that CH's own order lands on playwright-core 1.58.1,
//       whose firefox-1509/webkit-2248 revisions are NOT installed on this
//       machine (installed: firefox-1538, webkit-2336 = 1.62.1), so an
//       un-overridden run silently means "Chromium only". launchEngines
//       therefore reports, per engine, whether it launched and why not —
//       a skipped engine must never look like a passing engine.
//
//   decodePng / pixelAt
//       A screenshot is a PNG buffer in Node. Reading presented pixels means
//       decoding it here rather than asking the page what it thinks it drew:
//       the whole point of the canvas probe is that the page's own answer
//       (getImageData on the in-frame canvas) is wrong. Minimal decoder,
//       8-bit non-interlaced only, which is what Playwright emits.
//
//   productionSrcdocCsp
//       EXTRACTED from src/cli/renderers/replay-viewer.client.js rather than
//       copied. A copy drifts silently; extraction throws when the function
//       is renamed, which is the failure we want.
//
//   serveDir / stats
//       A local http server (so the page is a real origin, and so COOP+COEP
//       can lift performance.now()'s Spectre clamp for the latency probe) and
//       median/p95/min helpers.

import http from 'node:http';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, extname, sep } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..');

// ── Playwright resolution ──────────────────────────────────────────────────

export function resolvePlaywright() {
  const candidates = [
    process.env.PLAYWRIGHT_CORE_DIR,
    import.meta.url,
    '/opt/homebrew/lib/node_modules/openclaw/node_modules/',
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const pw = createRequire(base)('playwright-core');
      let version = 'unknown';
      try { version = createRequire(base)('playwright-core/package.json').version; } catch { /* best effort */ }
      return { pw, version, from: base };
    } catch { /* next */ }
  }
  return null;
}

export const ENGINE_NAMES = ['chromium', 'firefox', 'webkit'];

/**
 * Launch every engine the resolved playwright-core can actually start.
 * Returns [{ name, browser, ok, reason }] — a failed launch is reported,
 * never silently dropped, so "3 engines green" cannot mean "1 engine green
 * and 2 missing".
 */
export async function launchEngines(pw, { only = null, headless = true } = {}) {
  const wanted = only ? only.split(',').map((s) => s.trim()).filter(Boolean) : ENGINE_NAMES;
  const out = [];
  for (const name of wanted) {
    const launcher = pw[name];
    if (!launcher) { out.push({ name, browser: null, ok: false, reason: 'not exposed by playwright-core' }); continue; }
    try {
      const browser = await launcher.launch({ headless });
      out.push({ name, browser, ok: true, reason: null });
    } catch (e) {
      out.push({ name, browser: null, ok: false, reason: String(e.message || e).split('\n')[0] });
    }
  }
  return out;
}

// ── PNG decode (8-bit, non-interlaced) ─────────────────────────────────────

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function decodePng(buf) {
  if (!buf || buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new Error('not a PNG buffer');
  }
  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!ihdr) throw new Error('PNG has no IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`PNG bit depth ${ihdr.bitDepth} unsupported (probe expects 8)`);
  if (ihdr.interlace !== 0) throw new Error('interlaced PNG unsupported');

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[ihdr.colorType];
  if (!channels) throw new Error(`PNG colour type ${ihdr.colorType} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const { width, height } = ihdr;
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let prev = Buffer.alloc(stride);
  let p = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0;   // left
      const b = prev[i];                                   // up
      const c = i >= channels ? prev[i - channels] : 0;    // up-left
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      } else if (filter !== 0) {
        throw new Error(`unknown PNG filter ${filter} on row ${y}`);
      }
      line[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const s = x * channels, d = (y * width + x) * 4;
      if (channels === 1) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = 255; }
      else if (channels === 2) { out[d] = out[d + 1] = out[d + 2] = line[s]; out[d + 3] = line[s + 1]; }
      else if (channels === 3) { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = 255; }
      else { out[d] = line[s]; out[d + 1] = line[s + 1]; out[d + 2] = line[s + 2]; out[d + 3] = line[s + 3]; }
    }
    prev = line;
  }
  return { width, height, data: out };
}

/** [r,g,b,a] at image coordinates (x, y). */
export function pixelAt(img, x, y) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) {
    throw new Error(`sample (${xi},${yi}) outside ${img.width}x${img.height} screenshot`);
  }
  const d = (yi * img.width + xi) * 4;
  return [img.data[d], img.data[d + 1], img.data[d + 2], img.data[d + 3]];
}

/** Per-channel RGB comparison within `tol` (design §3.2 uses 8/255). */
export function rgbNear(got, want, tol = 8) {
  return [0, 1, 2].every((i) => Math.abs(got[i] - want[i]) <= tol);
}

export const rgb = (p) => `[${p[0]},${p[1]},${p[2]}]`;

// ── Production CSP, extracted not copied ───────────────────────────────────

const VIEWER_SRC_PATH = join(repoRoot, 'src', 'cli', 'renderers', 'replay-viewer.client.js');

function extractFn(src, name) {
  // The viewer is an IIFE of 2-space-indented function declarations; match to
  // the closing brace at that indent.
  const re = new RegExp(`\\n  function ${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n  \\}`);
  const hit = re.exec(src);
  if (!hit) {
    throw new Error(
      `could not extract ${name}() from ${VIEWER_SRC_PATH} — the probe must test the ` +
      'PRODUCTION string, so a rename here is a probe failure, not a fallback');
  }
  return hit[0];
}

/** The literal srcdocCsp() the shipped viewer uses, evaluated here. */
export function productionSrcdocCsp(allowExternalCss = false) {
  const src = readFileSync(VIEWER_SRC_PATH, 'utf8');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${extractFn(src, 'srcdocCsp')}\nreturn srcdocCsp;`)();
  const csp = fn(allowExternalCss);
  for (const must of ["default-src 'none'", 'img-src * data:', "frame-src 'none'", "style-src 'unsafe-inline'"]) {
    if (!csp.includes(must)) throw new Error(`extracted CSP lost "${must}": ${csp}`);
  }
  return csp;
}

/** The shell <head> the production viewer writes, minus recording stylesheets. */
export function productionShellHead(allowExternalCss = false) {
  return '<meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${productionSrcdocCsp(allowExternalCss)}">` +
    '<meta name="referrer" content="no-referrer">' +
    '<style>html{scrollbar-width:none}html::-webkit-scrollbar{width:0;height:0}</style>';
}

// ── Static server ──────────────────────────────────────────────────────────

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' };

/**
 * Serve `files` (a Map of path -> string) plus, as a fallback, files under
 * repoRoot. `isolate` adds COOP+COEP so the renderer is crossOriginIsolated
 * and performance.now() loses its 100 us Spectre clamp (T3's trick).
 */
export async function serveFiles(files, { isolate = true } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const head = {
      'Content-Type': MIME[extname(url.pathname)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    };
    if (isolate) {
      head['Cross-Origin-Opener-Policy'] = 'same-origin';
      head['Cross-Origin-Embedder-Policy'] = 'require-corp';
      head['Cross-Origin-Resource-Policy'] = 'same-origin';
    }
    if (files.has(url.pathname)) {
      res.writeHead(200, head);
      res.end(files.get(url.pathname));
      return;
    }
    const abs = resolve(repoRoot, '.' + url.pathname);
    if (!abs.startsWith(repoRoot + sep)) { res.writeHead(403).end(); return; }
    let body = null;
    try { body = await readFile(abs); } catch { /* 404 below */ }
    if (body === null) { res.writeHead(404, head); res.end('not found'); return; }
    res.writeHead(200, head);
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

// ── Stats ──────────────────────────────────────────────────────────────────

export function median(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
export function p95(xs) {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
}
export const minOf = (xs) => (xs.length ? Math.min(...xs) : NaN);
export const fixed = (x, n = 3) => (Number.isFinite(x) ? x.toFixed(n) : 'n/a');
