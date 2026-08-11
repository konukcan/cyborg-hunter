// src/replay/capture-dom.js
// Tier-2 ("dom") capture, wired to the v2 node-tree pipeline: keyframe
// snapshots (snapshot.js), MutationObserver batches → `dom.*` patches
// (mutations.js), the `initial_state` seed (initial-state.js), initial
// stylesheet capture, and the guard-friction pre-scramble hook.
//
// This module owns no serialization logic of its own any more. It is the
// WIRING: what the observed root is, when a keyframe is taken, which span the
// ids come from, and how a batch reaches the recorder. Everything it used to
// do by hand is now a shared, separately tested module — which is the point:
// the keyframe and the patches that address it must agree about exclusion,
// redaction and node identity, and the only way to guarantee that is for both
// to run the same code.
//
// What retired here at the v2 switchover (spec §14's CH migration list):
//   - the HTML-STRING walker (`serializeDom`) and its iframe span placeholder,
//     void-tag table and escaping. A keyframe is a DomNode tree (spec §4);
//     iframes are recorded as the element itself with no children (§13).
//   - the NONCE MARKER registry (`data-chn-*`). Integer node ids scoped to a
//     keyframe span replaced it, so nothing has to be stamped into serialized
//     markup and harvested back out by the viewer.
//   - CHILD-INDEX PATHS (`nodePath`) and the `mutation` patch shape. Patches
//     address nodes by id (§5.1).
//   - INTRA-BATCH DEDUP and the characterData→childList fold. Both existed
//     because a v1 childList patch re-serialized the target's whole resulting
//     children; a `dom.add` carries only what was inserted. mutations.js's
//     header records the reasoning, and its batch pre-scan is why the observer
//     callback below hands over the COMPLETE records array untouched.
//   - the DUPLICATED redaction predicates. redaction.js is the one definition
//     (spec §8 makes redaction a property of the file, which is a claim only a
//     single predicate can make checkable).

import { serializeTree } from './snapshot.js';
import { mapMutations, MUTATION_OBSERVER_INIT } from './mutations.js';
import { buildInitialState } from './initial-state.js';
import { createSpan } from './span.js';

/**
 * Initial stylesheet capture (spec §2 `StylesheetSnapshot`).
 *
 * Ids are the array position plus one, assigned here because the format wants
 * them: `stylesheet_events` addresses sheets by id, and even with that stream
 * empty (CH captures no CSSOM mutations — spec §13's known limit) a consumer
 * reads the two arrays as one addressable set.
 *
 * `kind` follows the sheet's origin rather than its readability: a <link>
 * stays a link sheet even when its rules are readable same-origin, and its
 * `css` is filled in when they are. A cross-origin sheet throws on `cssRules`,
 * so only the (absolute) href survives — the viewer can link it, nothing can
 * inline it.
 */
export function captureStylesheets(doc) {
  var out = [];
  var sheets = (doc && doc.styleSheets) || [];
  for (var i = 0; i < sheets.length; i++) {
    var sheet = sheets[i];
    var href = sheet.href || null;
    var media = sheet.media && sheet.media.mediaText ? sheet.media.mediaText : null;
    var css = null;
    try {
      var rules = sheet.cssRules;
      var text = [];
      for (var r = 0; r < rules.length; r++) text.push(rules[r].cssText);
      css = text.join('\n');
    } catch (e) {
      css = null;                      // cross-origin: unreadable from here
    }
    out.push(href
      ? { id: i + 1, kind: 'link', href: href, css: css, media: media }
      : { id: i + 1, kind: 'inline', css: css == null ? '' : css, media: media });
  }
  return out;
}

// How many characters a keyframe payload costs, as the wire would carry it.
// Exact rather than estimated: the trial's size budget is a bound on the
// payload, and the payload is a JSON tree, so its JSON length is the thing
// being bounded. Measured ONCE per keyframe and used twice — to decide whether
// the snapshot itself is over budget, and to seed the recorder's per-trial
// character count, which cannot see anything stored on the trial.
function payloadChars(value) {
  if (value == null) return 0;
  try { return JSON.stringify(value).length; } catch (e) { return 0; }
}

/**
 * Attaches tier-2 capture to a recorder:
 *  - a KEYFRAME at each trial start: the DomNode tree plus its `initial_state`
 *    seed, both taken on the shared capture span
 *  - MutationObserver batches → `dom.*` patch events
 *  - initial stylesheet capture at attach
 *  - guard-friction cooperation: onViolation('start') fires synchronously
 *    BEFORE obfuscateContent() (pinned by contract test), so the clean-DOM
 *    snapshot taken inside the callback is genuinely pre-scramble.
 *
 * @param {object} rec  the recorder
 * @param {object} env  {doc, win, now, MutationObserver} for testing, plus the
 *   two capture-wide objects the assembly (index.js) threads to BOTH capture
 *   modules:
 *     `span`     the capture span (span.js) — node ids and the file's own
 *                record of what it contains. The SAME object capture-trace
 *                gets, because an event's `target` and a patch's `node` are
 *                the same numbering or neither means anything.
 *     `scrolled` a function returning capture-trace's set of elements that
 *                have scrolled, which the keyframe seed enumerates (spec §3
 *                `element_scroll`). Only the scroll listener knows this.
 */
export function attachDomCapture(rec, env) {
  env = env || {};
  var doc = env.doc || document;
  var win = env.win || window;
  var now = env.now || function () { return performance.now(); };
  var MutationObserverImpl = env.MutationObserver ||
    (typeof MutationObserver !== 'undefined' ? MutationObserver : null);
  // A lone attachment (a test wiring this module by itself) gets its own span
  // rather than an ambient shared one: a module-level default is what lets a
  // stray serialization write into a live recording's model (span.js).
  var span = env.span || createSpan();
  var scrolled = typeof env.scrolled === 'function'
    ? env.scrolled : function () { return null; };
  // One options bag for every consumer — the snapshot walk, the mutation
  // mapper, the seed and the guard snapshot. Exclusion and redaction cannot be
  // answered one way in the keyframe and another way in a patch if there is
  // only one answer to hand around.
  var opts = {
    keepBait: rec.config.keepBait,
    redactSelector: rec.config.redactSelector,
    taint: env.taint,
  };

  // THE OBSERVED ROOT, resolved ONCE.
  //
  // v1 re-resolved it at every snapshot and every batch, which let the keyframe
  // and the patches addressing it describe two different elements if the page
  // replaced the container — and the observer, attached to whichever element
  // existed first, would have been watching neither. The recording's root is by
  // definition the element the observer watches, so it is resolved here and
  // held. (Task 4's residual: the seed's "did anything get walked" guard
  // catches a never-walked span, not a walk of a DIFFERENT root. One root
  // identity is what makes that unreachable rather than merely unlikely.)
  var root = resolveRoot();

  function resolveRoot() {
    var r = rec.config.root;
    if (typeof r === 'string') {
      try { return doc.querySelector(r) || doc.body; } catch (e) { return doc.body; }
    }
    return r || doc.body;
  }

  // Spec §2 types `observed_root` as a SELECTOR, so an element handed over
  // directly is reported by its id when it has one and as null otherwise —
  // null meaning "the document body", which is also the default.
  function rootSelector() {
    var r = rec.config.root;
    if (typeof r === 'string' && r) return r;
    if (root && root.id) return '#' + root.id;
    return null;
  }

  rec.setObservedRoot(rootSelector());

  try {
    rec.setStylesheets(captureStylesheets(doc));
  } catch (e) { rec.captureFailure('stylesheets', e); }

  // ── Keyframes (spec §3) ──
  // A keyframe at the start of every trial, which is v1's cadence and the
  // spec's advice for wiping hosts. Task 8 makes it size-aware for
  // persistent-DOM hosts; until then every segment is a keyframe and no
  // segment is a continuation, which is a legal recording either way.
  //
  // The order is a contract, not a preference: reset, then walk, then seed.
  // `span.reset()` restarts ids at 1 and empties the delivered picture in one
  // call (span.js), the walk is the span's first allocation so the tree numbers
  // 1..N, and the seed reads the ids that walk assigned. Taken in any other
  // order the seed names nodes the file does not contain.
  rec.onTrialStart(function (trial) {
    try {
      span.reset();
      var tree = serializeTree(root, span, opts);
      var seed = buildInitialState(root, span, {
        win: win,
        scrolled: scrolled(),
        keepBait: opts.keepBait,
        redactSelector: opts.redactSelector,
        taint: opts.taint,
      });
      var chars = payloadChars(tree) + payloadChars(seed);
      var cap = rec.config.maxCharsPerTrial;
      if (cap != null && chars > cap) {
        // The keyframe is the single largest capture source and is stored on
        // the trial rather than pushed as an event, so the recorder's cap
        // cannot refuse it — it is refused HERE, or a giant DOM bypasses the
        // payload limit entirely. The trial then replays as "no DOM captured".
        rec.captureFailure('dom_snapshot', new Error(
          'initial DOM keyframe of ' + chars + ' chars exceeds maxCharsPerTrial ' +
          cap + '; dropped to bound payload size'));
        trial.initialDom = null;
        trial.initialState = null;
        // The walk told the span the player holds this tree. It does not: the
        // keyframe is not in the file. Resetting again empties that picture, so
        // the patches that follow address nothing and are dropped rather than
        // naming ids no player ever received.
        span.reset();
      } else {
        trial.initialDom = tree;
        trial.initialState = seed;
        rec.noteSnapshotChars(trial, chars);
      }
    } catch (e) {
      rec.captureFailure('dom_snapshot', e);
      trial.initialDom = null;
      trial.initialState = null;
      span.reset();
    }
  });

  // ── Mutations (spec §5.1) ──
  if (MutationObserverImpl) {
    var observer = new MutationObserverImpl(function (records) {
      try {
        // The COMPLETE batch, in the observer's own order. mapMutations
        // pre-scans it (which removals and insertions are still to come, what
        // each attribute held before the batch) and that pre-scan is what makes
        // the mapping batch-coherent — filtering or reordering records here
        // would silently break it.
        var events = mapMutations(records, {
          root: root,
          span: span,
          // One callback = one `t` (spec §7): the batch is one task's worth of
          // DOM change, and the observer reports it with no per-record times.
          t: now(),
          keepBait: opts.keepBait,
          redactSelector: opts.redactSelector,
          taint: opts.taint,
        });
        for (var i = 0; i < events.length; i++) {
          rec.pushRecord(events[i], events[i].t);
        }
      } catch (e) { rec.captureFailure('mutations', e); }
    });
    try {
      observer.observe(root, MUTATION_OBSERVER_INIT);
      // Registered through the listener registry with the observer marker so
      // recorder.destroy() disconnects it (same convention as core monitor).
      rec.addListener(
        { addEventListener: function () {}, removeEventListener: function () {} },
        '_mutation_observer', observer, { _isObserver: true });
    } catch (e) { rec.captureFailure('mutations', e); }
  }

  // ── Guard-friction cooperation ──
  // Snapshot the clean DOM synchronously when a violation starts (before
  // friction scrambles content), so the analyst can see exactly what the
  // participant saw at the moment of violation.
  //
  // The snapshot is taken on a THROWAWAY SPAN. It is not part of the recording
  // the player replays — it is a CH diagnostic in the vendor namespace — so
  // numbering it into the live span would tell the live recording that the
  // player holds nodes it was never sent, and suppress the next patch for each
  // of them (span.js, D1). Its ids are internal to itself and start at 1; a
  // reader compares it to the recording by structure, not by id.
  //
  // The violation itself is a session-level vendor entry, not an event: spec
  // §5.8 admits no vendor event types in the stream, and there is no standard
  // event for "the participant left fullscreen".
  function guardSnapshot() {
    var tree = serializeTree(root, createSpan(), opts);
    var cap = rec.config.maxCharsPerTrial;
    // Bounded by the same budget a keyframe is: this is a whole second copy of
    // the DOM, and unlike a keyframe it rides a session-level array that no
    // per-trial cap can see.
    if (cap != null && payloadChars(tree) > cap) {
      rec.captureFailure('guard_violation', new Error(
        'pre-scramble DOM snapshot exceeds maxCharsPerTrial ' + cap + '; withheld'));
      return null;
    }
    return tree;
  }

  if (win.GuardFriction && typeof win.GuardFriction.onViolation === 'function') {
    try {
      // Late-subscription hardening: if a violation is ALREADY in progress
      // when replay attaches (friction started first — e.g. standalone
      // wiring order, or a participant who was out of fullscreen from the
      // very beginning), its phase:'start' emission is long gone. Synthesize
      // it from friction's current state so the recording never silently
      // misses an ongoing violation.
      // Local invariant guard: assembly (index.js) only attaches captures
      // after startSession(), but make that self-evident here — synthesize
      // only when the recorder is actually recording.
      var recState = rec.getState().state;
      if ((recState === 'session' || recState === 'trial') &&
          typeof win.GuardFriction.getCurrentState === 'function') {
        var gs = win.GuardFriction.getCurrentState();
        if (gs && gs.in_violation) {
          rec.pushGuardViolation({
            reason: gs.current_reason || 'unknown',
            phase: 'start',
            synthesized_at_subscribe: true,
            // NOT pre_scramble_dom: in enforcement mode the page may already
            // be scrambled by the time we subscribe — this snapshot is
            // whatever the DOM looks like right now, and its name must not
            // overclaim (an analyst could otherwise read scrambled content
            // as what the participant "really saw" pre-violation).
            dom_at_subscribe: guardSnapshot()
          }, now());
        }
      }
      win.GuardFriction.onViolation(function (violation) {
        try {
          if (violation && violation.phase === 'start') {
            rec.pushGuardViolation({
              reason: violation.reason,
              phase: 'start',
              pre_scramble_dom: guardSnapshot()
            }, now());
          } else if (violation && violation.phase) {
            rec.pushGuardViolation({
              reason: violation.reason, phase: violation.phase,
              duration_ms: violation.duration != null ? violation.duration : null
            }, now());
          }
        } catch (e) { rec.captureFailure('guard_violation', e); }
      });
    } catch (e) { rec.captureFailure('guard_violation', e); }
  }

  // (No return value: all wiring goes through recorder hooks.)
}
