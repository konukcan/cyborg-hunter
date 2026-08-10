// Conformance runner: every fixtures/*.json is checked against its
// expectations/*.json twin. A new fixture enrolls by existing on disk — no
// registry to update, so T4's converter output and T7's corpus join for free.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateStrict, validateTolerant, detectGzip } from './validator.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures');
const EXP = join(HERE, 'expectations');

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[/^\d+$/.test(k) ? Number(k) : k]), obj);
}

const INVARIANT_CHECKS = {
  // Re-implemented independently of validator.js on purpose: the runner is
  // the oracle's oracle — a validator bug must not self-certify.
  time_sorted(rec) {
    for (const s of rec.segments) {
      for (let i = 1; i < s.events.length; i++) {
        if (s.events[i].t < s.events[i - 1].t) return `segment ${s.index} events unsorted at ${i}`;
      }
    }
    return null;
  },
  index_matches_position(rec) {
    const bad = rec.segments.findIndex((s, i) => s.index !== i);
    return bad === -1 ? null : `segment at position ${bad} has index ${rec.segments[bad].index}`;
  },
  first_dom_bearing_is_keyframe(rec) {
    for (const s of rec.segments) {
      const hasDom = s.initial_dom != null || s.events.some(e => e.type?.startsWith('dom.'));
      if (!hasDom) continue;
      return s.initial_dom != null ? null : `first DOM-bearing segment ${s.index} is not a keyframe`;
    }
    return null;
  },
  // Spec §8 privacy floor, machine-checked. A redacted event may carry a
  // length (value_len) and nothing else identifying: no content, no key
  // identity. The scan recurses, because content hides below the top level
  // too — a redacted dom.add whose node subtree still holds `text`, or an
  // element whose `attrs.value` survives, leaks exactly as much as a
  // top-level `text` would. Key presence, not value: an explicit
  // `value: undefined` (which JSON.stringify silently drops) is reported here
  // at the fixture, where it can be fixed.
  no_redaction_leak(rec) {
    const FORBIDDEN = new Set(['value', 'text', 'html', 'key', 'code']);
    const findLeak = (v, at) => {
      if (v == null || typeof v !== 'object') return null;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) {
          const hit = findLeak(v[i], `${at}[${i}]`);
          if (hit) return hit;
        }
        return null;
      }
      for (const k of Object.keys(v)) {
        if (FORBIDDEN.has(k)) return `${at}.${k}`;
        const hit = findLeak(v[k], `${at}.${k}`);
        if (hit) return hit;
      }
      return null;
    };
    for (const s of rec.segments) {
      for (let i = 0; i < s.events.length; i++) {
        const e = s.events[i];
        if (!e || e.redacted !== true) continue;
        const leak = findLeak(e, `segment ${s.index} event ${i} (${e.type})`);
        if (leak) return `redacted event still carries ${leak}`;
      }
    }
    return null;
  },
};

// Privacy is not opt-in. These run against every fixture whether or not its
// expectations name them, so a fixture cannot smuggle a leak past the runner
// by omission — the failure mode a per-fixture list invites once T7 grows the
// corpus. A negative fixture that deliberately carries a leak will fail here,
// loudly, and has to declare itself rather than pass in silence.
const ALWAYS_ON = ['no_redaction_leak'];

for (const file of readdirSync(FIX).filter(f => f.endsWith('.json'))) {
  test(`conformance: ${file}`, () => {
    const raw = readFileSync(join(FIX, file), 'utf8');
    const exp = JSON.parse(readFileSync(join(EXP, file), 'utf8'));
    const res = validateStrict(raw);
    assert.equal(res.ok, exp.strict_valid, `strict_valid mismatch: ${JSON.stringify(res.errors)}`);
    const rec = JSON.parse(raw);
    const eventsTotal = rec.segments.reduce((n, s) => n + s.events.length, 0);
    assert.equal(rec.segments.length, exp.counts.segments);
    assert.equal(eventsTotal, exp.counts.events_total);
    assert.equal(rec.segments.filter(s => s.initial_dom != null).length, exp.counts.keyframes);
    assert.equal(rec.segments.filter(s => s.initial_dom == null).length, exp.counts.continuations);
    for (const sc of exp.spot_checks) {
      assert.deepEqual(getPath(rec, sc.path), sc.equals, `spot check ${sc.path}`);
    }
    for (const inv of new Set([...ALWAYS_ON, ...exp.invariants])) {
      const failure = INVARIANT_CHECKS[inv](rec);
      assert.equal(failure, null, `invariant ${inv}: ${failure}`);
    }
  });

  test(`gzip round-trip: ${file}`, () => {
    const raw = readFileSync(join(FIX, file));
    const gz = gzipSync(raw);
    assert.equal(detectGzip(gz), true);
    assert.equal(detectGzip(raw), false);
    assert.deepEqual(JSON.parse(gunzipSync(gz).toString('utf8')), JSON.parse(raw.toString('utf8')));
  });

  test(`semantic preservation: ${file}`, () => {
    // Spec §11 preservation rule: loading a recording must not silently drop
    // fields. Foundation for T7's forward-compat fixture.
    const raw = readFileSync(join(FIX, file), 'utf8');
    const parsed = JSON.parse(raw);
    // The bare parse→serialize→parse anchor. Weak on its own — nothing
    // JSON.parse produces can fail it — and kept as the seam T7's
    // forward-compat fixture extends.
    assert.deepEqual(JSON.parse(JSON.stringify(parsed)), parsed);
    // The half with teeth. The contract asserted here is the strict one: for
    // every key the file carried, the loaded value must come back identical —
    // no removal, no rewrite, and no addition anywhere beneath it. That holds
    // because validateTolerant fills absent defaults at the TOP level only
    // ({...TOP_DEFAULTS, ...obj}) and never reaches inside segments. Unknown
    // forward-compat fields are what a key-whitelisting loader drops, and
    // dropping them silently is the §11 violation this catches.
    // The strictness is deliberate. If the loader ever starts defaulting
    // *within* a segment, this test fails, and that change gets argued for
    // rather than absorbed. CH's recorder-side serializer is the other half of
    // §11, but this directory lifts wholesale into a shared package and may not
    // import it, so the serializer's preservation test belongs to the CH-side
    // suite.
    const exp = JSON.parse(readFileSync(join(EXP, file), 'utf8'));
    const loaded = validateTolerant(raw);
    // Strict-valid implies tolerant-valid: strict runs tolerant first and
    // inherits its errors. So a strict-valid fixture that fails to load is a
    // loader regression, and saying so here is what stops the branch below
    // from absolving one — a tolerant loader that rejected everything would
    // otherwise satisfy the error branch and pass this test.
    if (exp.strict_valid) {
      assert.equal(loaded.ok, true,
        `tolerant load rejected a strict-valid fixture: ${JSON.stringify(loaded.errors)}`);
    }
    if (loaded.ok) {
      for (const k of Object.keys(parsed)) {
        assert.deepEqual(loaded.recording[k], parsed[k], `tolerant load altered top-level "${k}"`);
      }
    } else {
      // Reserved for fixtures declared tolerant-invalid (T7's negatives). They
      // have no normalized output to compare, so the bar is that the loader
      // says why it refused.
      assert.ok(loaded.errors.length > 0, 'tolerant load failed without reporting an error');
    }
  });
}

// Self-test of the runner's own machinery: a spot check whose path does not
// resolve must FAIL, never quietly pass. getPath returns undefined for an
// absent key, and node:assert/strict's deepEqual separates undefined from
// null — that pairing is what stops `{"equals": null}` from being satisfied
// by a key the producer forgot to emit. Keep both halves together.
test('getPath: an absent key is undefined and cannot satisfy {"equals": null}', () => {
  assert.equal(getPath({ a: {} }, 'a.b'), undefined);
  assert.throws(() => assert.deepEqual(getPath({ a: {} }, 'a.b'), null));
  // The real spot check it protects still resolves to a genuine null.
  assert.deepEqual(getPath({ segments: [{}, { initial_dom: null }] }, 'segments.1.initial_dom'), null);
});
