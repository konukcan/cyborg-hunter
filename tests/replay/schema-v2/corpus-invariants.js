// tests/replay/schema-v2/corpus-invariants.js
// Whole-recording properties the per-field validator cannot see.
//
// WHY THIS IS NOT validator.js. `validateStrict` walks the file field by field
// and answers "is each declared thing the type it says". Every check here needs
// something a field walk does not have: the set of ids a KEYFRAME SPAN emitted
// (references, duplicates), a comparison between a top-level flag and an event
// deep inside a segment (truncation), or a claim the expectations file makes
// about the recording as a whole (the perf frame). Putting them in the
// validator would mean the strict profile silently grew corpus semantics;
// putting them in the runner's body would mean they are re-read every time
// someone edits a test. They live here, named, and the runner runs ALL of them
// against EVERY parseable fixture.
//
// WHY THIS IS NOT AN IMPORT OF validator.js EITHER. The runner is the oracle's
// oracle (conformance.test.js's own words): a validator bug must not
// self-certify. Nothing here imports the validator — the one deliberate
// exception is the drift guard in corpus-invariants.test.js, whose entire job
// is to compare the two tables.
//
// SIGNATURE. Every check is `(rec, exp) => string | null` — null passes, a
// string is the failure and must NAME the offending location, because a
// negative fixture pins that string as its `expect_error`.

// ── shared structure: keyframe spans (spec §3/§4) ──────────────────────────
// Node ids are scoped to a keyframe plus its continuation segments and restart
// at each keyframe. Every id-bearing check below is span-scoped for that
// reason; a session-wide id set would call jspsych-full's fourteen restarts a
// corpus of duplicates.
export function keyframeSpans(rec) {
  const spans = [];
  rec.segments.forEach((s, i) => {
    if (s.initial_dom != null || spans.length === 0) spans.push([i]);
    else spans[spans.length - 1].push(i);
  });
  return spans;
}

// Every id a DomNode subtree introduces, in document order.
function treeIds(n, out) {
  if (n == null || typeof n !== 'object') return out;
  if (typeof n.id === 'number') out.push(n.id);
  for (const c of n.children ?? []) treeIds(c, out);
  return out;
}

// Which fields of each event type hold a NODE ID. Explicit rather than "every
// numeric field named node-ish": `touches[].id` is a pointer id, `input.select`
// values are strings, and a heuristic that guessed either would report
// dangling references that are not references at all.
const NODE_REF_FIELDS = {
  'dom.remove': ['node'], 'dom.attr': ['node'], 'dom.text': ['node'],
  'dom.add': ['parent', 'before'],
  'input.value': ['node'], 'input.checked': ['node'], 'input.select': ['node'],
  'scroll.element': ['node'],
  'media.play': ['node'], 'media.pause': ['node'], 'media.ended': ['node'],
  'media.seeked': ['node'], 'media.time': ['node'],
  'canvas.snapshot': ['node'],
  'mouse.down': ['target'], 'mouse.up': ['target'], 'mouse.click': ['target'],
  'key.down': ['target'], 'key.up': ['target'],
  'clipboard.copy': ['target'], 'clipboard.cut': ['target'],
  'clipboard.paste': ['target'], 'clipboard.drop': ['target'],
};

// ── §8 privacy floor: the redacted-variant allowlist ───────────────────────
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
  // `len` is numOrNull, not isNum. FOUND WHILE SETTLING THE §5.3 STRICTNESS
  // QUESTION (T7): copy and cut carry `len: null` by construction — the
  // clipboard is not populated when they fire, so any number read there would
  // be a fiction about the selection — and a redacted copy/cut is therefore a
  // conforming event with a null length. Typing this as isNum made the privacy
  // floor reject a recording that had done nothing wrong, which is the worst
  // failure mode an always-on scan has: it teaches people to declare
  // expect_leak to make it stop.
  allowed: { type: isStr, t: isNum, target: numOrNull, len: numOrNull, redacted: marker },
  // text/html survive a redacted clipboard event only as explicit nulls: the
  // producer saying "there was content, and it is gone" without carrying any.
  null_only: new Set(['text', 'html']),
};
export const REDACTED_SHAPES = {
  'key.down': REDACTED_KEY_EVENT,
  'key.up': REDACTED_KEY_EVENT,
  'input.value': { allowed: { type: isStr, t: isNum, node: isNum, redacted: marker, value_len: isNum } },
  'clipboard.copy': REDACTED_CLIPBOARD,
  'clipboard.cut': REDACTED_CLIPBOARD,
  'clipboard.paste': REDACTED_CLIPBOARD,
  'clipboard.drop': REDACTED_CLIPBOARD,
};

// Element nodes whose `type` attribute makes them a §8 password field. The
// attribute, not an IDL read: a file has no live element to ask.
const isPasswordNode = n => n != null && typeof n === 'object' && n.kind === 'element'
  && typeof n.attrs?.type === 'string' && n.attrs.type.toLowerCase() === 'password';

function collectPasswordIds(n, out) {
  if (n == null || typeof n !== 'object') return out;
  if (isPasswordNode(n)) out.add(n.id);
  for (const c of n.children ?? []) collectPasswordIds(c, out);
  return out;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

export const INVARIANT_CHECKS = {
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

  // Spec §8's floor (MUST): "values of <input type=password> are never
  // recorded, in any channel". STRUCTURAL, not textual — the leak-scan fixture
  // proves that one recording carries no sentinel, this proves that NO
  // recording carries a password value-bearing channel at all, including on
  // fixtures nobody thought to type a sentinel into. The three channels are
  // the three §8 names: the keyframe seed, the input stream, and attribute
  // writes. Span-scoped, because a password node's id means nothing outside
  // the keyframe span that numbered it, and a session-wide id set would let a
  // later span's ordinary <input type=text> inherit the accusation.
  password_floor(rec) {
    for (const span of keyframeSpans(rec)) {
      const pw = new Set();
      // Two ways in: stated as a password in the keyframe, or turned into one
      // mid-span by a dom.attr type write. A producer that emits the attribute
      // change and then the value would otherwise walk out through the second
      // door.
      for (const i of span) {
        collectPasswordIds(rec.segments[i].initial_dom, pw);
        for (const e of rec.segments[i].events) {
          if (e.type === 'dom.add') collectPasswordIds(e.node, pw);
          if (e.type === 'dom.attr' && e.name === 'type'
              && String(e.value).toLowerCase() === 'password') pw.add(e.node);
        }
      }
      if (pw.size === 0) continue;
      for (const i of span) {
        const s = rec.segments[i];
        const at = `segment ${s.index}`;
        for (const f of s.initial_state?.form ?? []) {
          if (pw.has(f.node) && (f.value !== undefined || f.selected !== undefined)) {
            return `${at}: initial_state.form seeds a value for password node ${f.node} (spec §8 floor)`;
          }
        }
        // The keyframe's own `value` attribute is the fourth channel, and the
        // only one whose absence a reader can mistake for "the page had no
        // default": an authored `value="…"` on a password input is markup, not
        // typing, and it is still a password value in the file.
        for (const id of passwordNodesWithValueAttr(s.initial_dom)) {
          return `${at}: initial_dom keeps a value attribute on password node ${id} (spec §8 floor)`;
        }
        for (let j = 0; j < s.events.length; j++) {
          const e = s.events[j];
          if (e.type === 'input.value' && pw.has(e.node) && e.redacted !== true) {
            return `${at} event ${j}: non-redacted input.value on password node ${e.node} (spec §8 floor)`;
          }
          if (e.type === 'dom.attr' && pw.has(e.node) && e.name === 'value' && e.value !== null) {
            return `${at} event ${j}: value-bearing dom.attr on password node ${e.node} (spec §8 floor)`;
          }
        }
      }
    }
    return null;
  },

  // Spec §5.7: capture_stopped is "emitted once … The top-level `truncated`
  // flag mirrors it." Two halves of one claim, and players are told to surface
  // truncation — a file that sets the flag with no event leaves a player
  // reporting truncation it cannot locate, and an event with no flag leaves a
  // player that only reads the flag presenting a partial recording as complete.
  truncation_mirrors_capture_stopped(rec) {
    const at = [];
    for (const s of rec.segments) {
      s.events.forEach((e, j) => {
        if (e.type === 'recording.capture_stopped') at.push(`segment ${s.index} event ${j}`);
      });
    }
    if (at.length > 1) return `recording.capture_stopped is emitted once (spec §5.7); found ${at.length} at ${at.join(', ')}`;
    if (rec.truncated === true && at.length === 0) {
      return 'truncated: true with no recording.capture_stopped event to mirror (spec §5.7)';
    }
    if (rec.truncated !== true && at.length === 1) {
      return `recording.capture_stopped at ${at[0]} is not mirrored by truncated: true (spec §5.7)`;
    }
    return null;
  },

  // T3 Task-1 carry. Strict validation number-checks `node`/`parent`/`before`,
  // so a reference to an id no keyframe and no dom.add ever emitted is a
  // well-typed dangling pointer: the player resolves nothing and, being
  // tolerant by design, says nothing. Checked in TIME ORDER within the span
  // rather than against the span's whole id set, because a reference that
  // arrives before its node does is the same defect with a different cause.
  references_resolve(rec) {
    for (const span of keyframeSpans(rec)) {
      const emitted = new Set();
      for (const i of span) {
        const s = rec.segments[i];
        if (s.initial_dom != null) for (const id of treeIds(s.initial_dom, [])) emitted.add(id);
        const at = `segment ${s.index}`;
        for (const [key, list] of Object.entries(s.initial_state ?? {})) {
          if (!Array.isArray(list)) continue;
          for (const entry of list) {
            if (typeof entry?.node === 'number' && !emitted.has(entry.node)) {
              return `${at}: initial_state.${key} references node ${entry.node}, which the keyframe span never emitted`;
            }
          }
        }
        for (let j = 0; j < s.events.length; j++) {
          const e = s.events[j];
          for (const f of NODE_REF_FIELDS[e.type] ?? []) {
            const v = e[f];
            if (typeof v === 'number' && !emitted.has(v)) {
              return `${at} event ${j} (${e.type}): ${f} references node ${v}, which the keyframe span never emitted`;
            }
          }
          if (typeof e.anchor?.node === 'number' && !emitted.has(e.anchor.node)) {
            return `${at} event ${j} (${e.type}): anchor.node references node ${e.anchor.node}, which the keyframe span never emitted`;
          }
          // Emission happens AFTER the event's own references are checked: a
          // dom.add may not use the id it is about to introduce as its parent.
          if (e.type === 'dom.add') for (const id of treeIds(e.node, [])) emitted.add(id);
        }
      }
    }
    return null;
  },

  // Duplicate node ids, WITH THE M5 CARVE-OUT (T3 Task-3 review). A move
  // legally encodes as dom.remove + dom.add carrying the SAME id inside one
  // span, so "this id was seen twice" is not a violation — "two nodes hold this
  // id at the same time" is. The tree is tracked as a live id set: remove takes
  // an id (and its subtree) out, add puts one back, and a collision is only
  // reported against ids currently live.
  //
  // The keyframe case is the one r3 is owed an answer on (T5 Task-3 fix round):
  // a keyframe TREE carrying the same id twice is undefended on the viewer's
  // non-body mount path, where the root binds last, so the two players disagree
  // about which node keeps the id. This corpus refuses the file rather than
  // picking a winner — with duplicates invalid, first-seen vs last-seen never
  // arises for a conforming recording, and §4's "assigned in first-seen order"
  // stays a statement about the producer rather than a tie-break rule players
  // have to share. If r3 decides otherwise, THIS is the check that changes.
  unique_node_ids(rec) {
    for (const span of keyframeSpans(rec)) {
      const live = new Set();
      // The live tree's parent→children edges, maintained across dom.add as
      // well as across the keyframe walk. Tracking only the keyframe's edges
      // was a real bug found on the generated `redacted` fixture: a text node
      // added under an element, then removed WITH that element and re-added
      // inside it, was reported as a duplicate because the element's child list
      // was still the one the keyframe described.
      const kids = new Map();
      const childrenOf = (id) => {
        if (!kids.has(id)) kids.set(id, new Set());
        return kids.get(id);
      };
      const mount = (n, parentId, at) => {
        if (n == null || typeof n !== 'object') return null;
        if (typeof n.id === 'number') {
          if (live.has(n.id)) return `${at}: node id ${n.id} is already live in this keyframe span`;
          live.add(n.id);
          if (typeof parentId === 'number') childrenOf(parentId).add(n.id);
        }
        for (const c of n.children ?? []) {
          const failure = mount(c, n.id, at);
          if (failure) return failure;
        }
        return null;
      };
      const unmount = (id) => {
        if (!live.delete(id)) return;
        for (const c of [...(kids.get(id) ?? [])]) unmount(c);
        kids.delete(id);
      };
      for (const i of span) {
        const s = rec.segments[i];
        if (s.initial_dom != null) {
          const failure = mount(s.initial_dom, null, `segment ${s.index} initial_dom`);
          if (failure) return failure;
        }
        for (let j = 0; j < s.events.length; j++) {
          const e = s.events[j];
          if (e.type === 'dom.remove' && typeof e.node === 'number') unmount(e.node);
          if (e.type === 'dom.add') {
            const failure = mount(e.node, e.parent, `segment ${s.index} event ${j} (dom.add)`);
            if (failure) return failure;
          }
        }
      }
    }
    return null;
  },

  // T3 Task-6 carry: which clock `ended_at_perf` is on.
  //
  // Spec §7 puts every event `t` on the wire clock (ms since
  // `recording_started_at_perf`) and says nothing about `ended_at_perf`, whose
  // §2 type is just `number | null`. CH's serializer keeps it ABSOLUTE — "so it
  // sits in the same frame as recording_started_at_perf; their difference is
  // the recording's duration in wire time" — and jsPsych-v1, carried through
  // the converter verbatim, states it on the wire clock instead. Both files are
  // strict-valid; a consumer computing a duration gets two different answers.
  //
  // A recording whose origin is 0 cannot tell the two apart (T3 Task-6 verified
  // this by flipping canonical-core to relative and watching it deep-equal), so
  // the third value is not a hedge: it is the finding, stated where a reader
  // will look for it. The expectations file DECLARES the frame and this check
  // holds the arithmetic to the declaration, which is what makes a fixture with
  // a large non-zero origin a pin rather than a note.
  perf_frame(rec, exp) {
    const declared = exp?.perf_frame;
    if (!declared) return 'expectations must declare perf_frame: "absolute" | "relative" | "undiscriminating"';
    const s0 = rec.recording_started_at_perf;
    const end = rec.ended_at_perf;
    if (typeof s0 !== 'number' || typeof end !== 'number') {
      return declared === 'undiscriminating' ? null
        : `perf_frame "${declared}" claims an arithmetic relation, but the recording states ` +
          `recording_started_at_perf=${s0} / ended_at_perf=${end}`;
    }
    // The last moment the file describes, on the wire clock.
    let last = 0;
    for (const s of rec.segments) {
      if (typeof s.t_end === 'number') last = Math.max(last, s.t_end);
      for (const e of s.events) if (typeof e.t === 'number') last = Math.max(last, e.t);
    }
    if (declared === 'undiscriminating') {
      if (s0 !== 0) return `perf_frame "undiscriminating" requires a zero perf origin; this one is ${s0}`;
      return end >= last ? null : `ended_at_perf (${end}) precedes the last observed moment (${last})`;
    }
    if (s0 === 0) return `perf_frame "${declared}" cannot be read off a zero perf origin — declare "undiscriminating"`;
    if (declared === 'absolute') {
      // The pin. Under the absolute reading the difference IS the wire-time
      // extent; under the relative reading the file would be claiming the
      // session outlived its last event by exactly the perf origin.
      const diff = end - s0;
      return Math.abs(diff - last) <= 0.1 ? null
        : `perf_frame "absolute": ended_at_perf − recording_started_at_perf = ${diff}, ` +
          `but the last observed moment on the wire clock is ${last}`;
    }
    if (declared === 'relative') {
      if (end < last) return `perf_frame "relative": ended_at_perf (${end}) precedes the last observed moment (${last})`;
      return end - s0 < last ? null
        : `perf_frame "relative": the absolute reading also fits (ended_at_perf − ` +
          `recording_started_at_perf = ${end - s0} ≥ ${last}), so this file does not discriminate`;
    }
    return `unknown perf_frame "${declared}"`;
  },
};

// Password nodes in a keyframe tree that still carry a `value` attribute.
function passwordNodesWithValueAttr(n, out = []) {
  if (n == null || typeof n !== 'object') return out;
  if (isPasswordNode(n) && typeof n.attrs?.value === 'string') out.push(n.id);
  for (const c of n.children ?? []) passwordNodesWithValueAttr(c, out);
  return out;
}

// Privacy is not opt-in. These two run against every parseable fixture whether
// or not its expectations name them, so a fixture cannot smuggle a leak past
// the runner by omission — the failure mode a per-fixture list invites once the
// corpus grows. A negative fixture that deliberately carries a leak fails here,
// loudly, and has to declare `expect_leak: true` rather than pass in silence.
export const PRIVACY_INVARIANTS = ['no_redaction_leak', 'password_floor'];

export const INVARIANT_NAMES = Object.keys(INVARIANT_CHECKS);
