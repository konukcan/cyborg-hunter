// tools/gen-expectations-counts.mjs
//
// Computes the `counts` block of a schema-v2 expectations file from the fixture
// itself, and prints an authoring inventory beside it.
//
// WHY THIS EXISTS. canonical-core is 3 segments and 14 events, so its
// expectations were counted by eye. jspsych-full is 14 segments and 909 events
// across 15 event types; counting those by hand produces numbers that agree
// with nobody, and a wrong number in an expectations file is worse than no
// number — it is a green test asserting a fiction. So the counts are computed,
// and the conformance runner recomputes them independently at test time. This
// script is a convenience for the author, never an oracle: nothing in the test
// suite imports it, and a bug here shows up as a failing conformance test
// rather than as a fixture that certifies itself.
//
// Usage:
//   node tools/gen-expectations-counts.mjs tests/replay/schema-v2/fixtures/jspsych-full.json
//     → the counts block on stdout, the authoring inventory on stderr
//   node tools/gen-expectations-counts.mjs <fixture> --inventory
//     → inventory only, on stdout

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The counts block the conformance runner asserts, recomputed there from the
// fixture: segments, total events, and the split between keyframes
// (`initial_dom` present) and continuations, plus the per-type event histogram.
export function countsOf(rec) {
  const eventsByType = {};
  let eventsTotal = 0;
  for (const s of rec.segments) {
    for (const e of s.events) {
      eventsTotal++;
      eventsByType[e.type] = (eventsByType[e.type] ?? 0) + 1;
    }
  }
  return {
    segments: rec.segments.length,
    events_total: eventsTotal,
    keyframes: rec.segments.filter(s => s.initial_dom != null).length,
    continuations: rec.segments.filter(s => s.initial_dom == null).length,
    // Sorted by count then name so the emitted block is stable across runs and
    // reads as an inventory of what the producer actually emitted.
    events_by_type: Object.fromEntries(
      Object.entries(eventsByType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    ),
  };
}

// Everything a spot-check author needs that is NOT an assertion: where the
// interesting events live, so the paths in `spot_checks` are read off the
// fixture rather than guessed.
function inventoryOf(rec) {
  const canvas = { full: [], region: [] };
  for (const s of rec.segments) {
    s.events.forEach((e, i) => {
      if (e.type !== 'canvas.snapshot') return;
      const at = `segments.${s.index}.events.${i}`;
      (e.region ? canvas.region : canvas.full).push(
        e.region ? { at, region: e.region } : { at, data_url_chars: e.data_url?.length ?? null }
      );
    });
  }
  const firstOf = {};
  for (const s of rec.segments) {
    s.events.forEach((e, i) => {
      firstOf[e.type] ??= `segments.${s.index}.events.${i}`;
    });
  }
  return {
    events_per_segment: rec.segments.map(s => s.events.length),
    first_path_by_type: firstOf,
    canvas_snapshots: canvas,
    stylesheets: (rec.stylesheets ?? []).map(s => ({
      id: s.id, kind: s.kind, media: s.media,
      css_chars: s.css == null ? null : s.css.length,
      href: s.href ?? null,
    })),
    stylesheet_events: (rec.stylesheet_events ?? []).map(e => ({
      type: e.type, id: e.id ?? e.sheet?.id ?? null,
      sheet_kind: e.sheet?.kind ?? null,
      css_chars: e.sheet?.css == null ? (e.css == null ? null : e.css.length) : e.sheet.css.length,
    })),
    rng: rec.rng ?? null,
    rng_calls: (rec.rng_calls ?? []).length,
    // Zero of these is what makes `no_redaction_leak` vacuous on a fixture.
    redacted_events: rec.segments.reduce(
      (n, s) => n + s.events.filter(e => e.redacted).length, 0),
    extensions: rec.extensions ?? null,
  };
}

// CLI only when RUN, not when imported. tools/gen-negative-fixtures.mjs imports
// `countsOf` to build its expectations twins, and without this guard the import
// executed the argv parse below and exited with a usage message.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const inventoryOnly = args.includes('--inventory');
  const file = args.find(a => !a.startsWith('--'));
  if (!file) {
    process.stderr.write('usage: node tools/gen-expectations-counts.mjs <fixture.json> [--inventory]\n');
    process.exit(1);
  }
  const rec = JSON.parse(readFileSync(resolve(process.cwd(), file), 'utf8'));
  const inventory = JSON.stringify(inventoryOf(rec), null, 2) + '\n';
  if (inventoryOnly) {
    process.stdout.write(inventory);
  } else {
    process.stdout.write(JSON.stringify(countsOf(rec), null, 2) + '\n');
    process.stderr.write(inventory);
  }
}
