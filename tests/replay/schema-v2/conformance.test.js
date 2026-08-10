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

// Spec §8's redacted variants, as the exact keys each may carry AND the scalar
// each of those keys must hold. An allowlist by design: a denylist of known-bad
// names only catches the leaks someone thought to name, and every new event
// type silently opts out of the privacy floor until somebody extends the list.
// Values are typed, not just names, because allowing the name `node` is not
// allowing arbitrary content beneath it: `node: { text: 'secret' }` is a leak
// wearing an allowed key. Typing every allowed key as a scalar is also what
// keeps this check flat — no allowed value can hold a subtree, so there is
// nothing left for a recursive scan to find.
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isStr = v => typeof v === 'string';
const numOrNull = v => v === null || isNum(v);
const marker = () => true;   // reached only when already truthy

const REDACTED_KEY_EVENT = { allowed: { type: isStr, t: isNum, redacted: marker } };
const REDACTED_CLIPBOARD = {
  allowed: { type: isStr, t: isNum, target: numOrNull, len: isNum, redacted: marker },
  // text/html survive a redacted clipboard event only as explicit nulls: the
  // producer saying "there was content, and it is gone" without carrying any.
  null_only: new Set(['text', 'html']),
};
const REDACTED_SHAPES = {
  'key.down': REDACTED_KEY_EVENT,
  'key.up': REDACTED_KEY_EVENT,
  'input.value': { allowed: { type: isStr, t: isNum, node: isNum, redacted: marker, value_len: isNum } },
  'clipboard.copy': REDACTED_CLIPBOARD,
  'clipboard.cut': REDACTED_CLIPBOARD,
  'clipboard.paste': REDACTED_CLIPBOARD,
  'clipboard.drop': REDACTED_CLIPBOARD,
};

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
  // Spec §8 privacy floor, machine-checked against REDACTED_SHAPES above. A
  // redacted event may carry a length (value_len) and nothing else
  // identifying: no content, no key identity, no subtree. Every allowed key is
  // typed as a scalar, so an event carrying a `node` object or an `attrs` bag
  // fails on that key's value and the old recursive scan has nothing left to
  // descend into. The scan's job is subsumed rather than dropped.
  // Key presence, not value, decides membership: an explicit
  // `value: undefined` (which JSON.stringify silently drops) is reported here
  // at the fixture, where it can still be fixed. Truthiness, not `=== true`,
  // opens the check: a producer emitting `redacted: 1` still claims the
  // redacted variant and is held to its floor. The privacy floor must not be
  // the thing that lets a sloppy marker through, and validateStrict rejects
  // the non-boolean marker on its own.
  no_redaction_leak(rec) {
    for (const s of rec.segments) {
      for (let i = 0; i < s.events.length; i++) {
        const e = s.events[i];
        if (!e || !e.redacted) continue;
        const at = `segment ${s.index} event ${i} (${e.type})`;
        const shape = REDACTED_SHAPES[e.type];
        if (!shape) return `${at}: no redacted variant defined for "${e.type}"`;
        for (const k of Object.keys(e)) {
          // hasOwn, not a truthiness lookup: `constructor` and friends resolve
          // to inherited functions and would read as allowed predicates.
          if (Object.hasOwn(shape.allowed, k)) {
            if (shape.allowed[k](e[k])) continue;
            return `${at}: redacted event key "${k}" does not hold the scalar its variant allows`;
          }
          if (shape.null_only?.has(k) && e[k] === null) continue;
          return `${at}: redacted event carries disallowed key "${k}"`;
        }
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

const FIXTURES = readdirSync(FIX).filter(f => f.endsWith('.json'));

// Enrollment sanity. Enrolling by existence is what makes new fixtures free,
// and it is also the failure mode with no symptom: an empty fixtures/ leaves a
// green suite that asserts nothing, and an expectations file whose twin was
// renamed or deleted simply stops being read. Neither shows up as a failing
// test anywhere else, so both are asserted directly.
test('enrollment: fixtures exist and every expectation has a fixture twin', () => {
  assert.ok(FIXTURES.length > 0, 'fixtures/ holds no *.json — the conformance suite would pass vacuously');
  const enrolled = new Set(FIXTURES);
  for (const e of readdirSync(EXP).filter(f => f.endsWith('.json'))) {
    assert.ok(enrolled.has(e), `expectations/${e} has no fixtures/${e} twin — it is being silently skipped`);
  }
});

for (const file of FIXTURES) {
  test(`conformance: ${file}`, () => {
    const raw = readFileSync(join(FIX, file), 'utf8');
    const exp = JSON.parse(readFileSync(join(EXP, file), 'utf8'));
    // An expectations file that names a different fixture is being applied to
    // the wrong recording; a missing block would make its assertions no-ops.
    assert.equal(exp.fixture, file, `expectations/${file} declares fixture "${exp.fixture}"`);
    assert.ok(exp.counts, `expectations/${file} has no counts block`);
    assert.ok(Array.isArray(exp.spot_checks), `expectations/${file} has no spot_checks array`);
    assert.ok(Array.isArray(exp.invariants), `expectations/${file} has no invariants array`);
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
      // A typo'd invariant name would otherwise throw "not a function" — a
      // failure that reads like a runner crash rather than a fixture defect.
      assert.ok(INVARIANT_CHECKS[inv], `expectations/${file} names unknown invariant "${inv}"`);
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

// Self-tests of the privacy floor. The allowlist is the one invariant that
// runs against every fixture unconditionally, so its own reject direction has
// to be proven on synthetic events rather than inferred from a corpus that
// (correctly) contains no leaks.
function redactedRec(...events) {
  return { segments: [{ index: 0, initial_dom: null, events }] };
}

test('no_redaction_leak: a redacted event type with no defined variant is refused', () => {
  const failure = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'canvas.snapshot', t: 1, node: 2, data_url: 'data:image/png;base64,AAA', redacted: true }));
  assert.match(String(failure), /no redacted variant defined for "canvas\.snapshot"/);
});

test('no_redaction_leak: a redacted event carrying a key outside its allowlist fails, naming the key', () => {
  const leaked = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'input.value', t: 1, node: 3, redacted: true, value_len: 4, value: 'leak' }));
  assert.match(String(leaked), /disallowed key "value"/);
  const keyed = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'key.down', t: 1, redacted: true, code: 'KeyA' }));
  assert.match(String(keyed), /disallowed key "code"/);
  // Truthiness, not `=== true`: a producer emitting `redacted: 1` is held to
  // the same floor. (The strict validator rejects the non-boolean marker
  // separately; the privacy floor must not depend on that having run.)
  const truthy = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'input.value', t: 1, node: 3, redacted: 1, value_len: 4, value: 'leak' }));
  assert.match(String(truthy), /disallowed key "value"/);
});

test('no_redaction_leak: an allowlisted key must carry the scalar it claims', () => {
  // Allowing a key name is not allowing arbitrary content under it. `node` is
  // an id on a redacted input.value; an object there hides exactly the
  // plaintext the redaction removed, and a name-only allowlist would wave it
  // through. This is what keeps the check flat: every allowed key is a scalar,
  // so there is no subtree left for a recursive scan to descend into.
  const nested = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'input.value', t: 1, node: { text: 'secret' }, redacted: true, value_len: 6 }));
  assert.match(String(nested), /"node"/);
  const bagged = INVARIANT_CHECKS.no_redaction_leak(
    redactedRec({ type: 'clipboard.paste', t: 1, target: null, len: { html: 'secret' }, redacted: true }));
  assert.match(String(bagged), /"len"/);
});

test('no_redaction_leak: the spec-defined redacted variants pass', () => {
  assert.equal(INVARIANT_CHECKS.no_redaction_leak(redactedRec(
    { type: 'key.down', t: 1, redacted: true },
    { type: 'key.up', t: 2, redacted: true },
    { type: 'input.value', t: 3, node: 4, redacted: true, value_len: 1 },
    // text/html on a redacted clipboard event are tolerated only as explicit
    // nulls: "there was content, and it is gone".
    { type: 'clipboard.paste', t: 4, target: null, len: 5, redacted: true, text: null, html: null },
  )), null);
  // A non-redacted event is not the allowlist's business — it keeps its content.
  assert.equal(INVARIANT_CHECKS.no_redaction_leak(redactedRec(
    { type: 'input.value', t: 1, node: 3, value: 'abc' },
  )), null);
});
