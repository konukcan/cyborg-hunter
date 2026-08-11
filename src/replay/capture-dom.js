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
 * Keyframe or continuation? (spec §3's cadence guidance.)
 *
 * Pure, so the boundaries a scripted DOM cannot hit on purpose are testable
 * directly. `cadence` is the bookkeeping the attachment keeps per span:
 *
 *   `hasKeyframe`       has a keyframe of THIS span reached the file? False at
 *                       the start of a recording and after a keyframe was
 *                       dropped or threw — in both cases there is nothing for
 *                       a continuation to continue from, and §3 requires the
 *                       first DOM-bearing segment to be a keyframe.
 *   `segments`          segments opened in this span, the keyframe included.
 *   `patchChars`        the plan's `bytesSinceKeyframe`. See below.
 *   `lastSnapshotChars` what the span's keyframe cost the file: the exact JSON
 *                       length of its tree plus its `initial_state` seed (the
 *                       same number `noteSnapshotChars` gets). 0 when no
 *                       keyframe has been measured.
 *
 * WHAT `patchChars` COUNTS, exactly: the sum over every observer batch flushed
 * since the keyframe of `JSON.stringify(patches).length`, where `patches` is
 * the array of `dom.*` events that batch mapped to.
 *
 *   - CHARS, not bytes. The plan and design call it `bytesSinceKeyframe`; it is
 *     measured in the same unit as `maxCharsPerTrial` (UTF-16 code units, which
 *     UTF-8 byte size can exceed for non-ASCII), so it carries that config's
 *     name for that config's reason. Both sides of the comparison use it, so
 *     the ratio the trigger actually tests is unit-free.
 *   - `dom.*` ONLY, on FILE-SIZE grounds — not because trace events carry no
 *     state. Some of them plainly do: `input.value`, `scroll.*` and `media.*`
 *     are exactly the state `initial_state` re-states (spec §3 `form`,
 *     `scroll`, `element_scroll`, `media`), and their keyframe-side cost is
 *     priced into `lastSnapshotChars` through the seed. What makes them
 *     uncountable here is that a keyframe does not REMOVE them from the file —
 *     playback needs every one of them — so §3's "at parity the keyframe is
 *     free" argument, which is the whole basis of this comparison, does not
 *     apply. Counting them would keyframe on volume the keyframe cannot
 *     reclaim. The consequence is real and belongs on the record: on a
 *     form-heavy or scroll-heavy but DOM-STATIC segment this trigger can never
 *     fire, and `keyframeEvery` becomes the only bound on seek distance and on
 *     a corrupt event's blast radius — §3's failure mode from the other side.
 *   - AT EMISSION, before the recorder's per-trial caps can refuse a record, and
 *     off the in-memory event (absolute `t`) rather than the wire event
 *     (session-relative, usually shorter). Both make the count an over-estimate:
 *     MEASURED at 1.08x, 5.3 chars per patch over 12 `dom.attr` patches (864
 *     in-memory against 800 on the wire), all of it the timestamp. It biases
 *     toward keyframing sooner — the direction that shortens seek distance and
 *     shrinks the blast radius of a corrupt event.
 *
 * @param {{hasKeyframe: boolean, segments: number, patchChars: number,
 *          lastSnapshotChars: number}} cadence
 * @param {number|null} keyframeEvery  segment fallback (recorder config)
 */
export function shouldKeyframe(cadence, keyframeEvery) {
  if (!cadence.hasKeyframe) return true;
  // The fallback: at most `keyframeEvery` segments per span, so segment N of a
  // span (counting the keyframe as 1) is where the next keyframe lands.
  //
  // The `typeof` is deliberately strict, and diverges from the sibling caps —
  // `maxViewportChanges` would coerce a string `"10"` and work. Here a wrong
  // TYPE must not silently become a different CADENCE: `"10"` from a JSON
  // config or a URL parameter would compare as a string and disable the
  // fallback, changing the shape of the researcher's file with no other
  // symptom. It is refused rather than coerced, and `attachDomCapture` warns
  // once about it at attach, which is where a misconfiguration is still
  // fixable.
  if (typeof keyframeEvery === 'number' && keyframeEvery >= 1 &&
      cadence.segments >= keyframeEvery) return true;
  // The size trigger: spec §3's self-tuning rule — take a keyframe once the
  // accumulated mutation volume rivals a fresh snapshot's size, because at that
  // point the keyframe is free in file size. `>=` so parity keyframes.
  // Guarded on a measured keyframe: 0 would make the comparison vacuously true.
  return cadence.lastSnapshotChars > 0 &&
         cadence.patchChars >= cadence.lastSnapshotChars;
}

/**
 * Attaches tier-2 capture to a recorder:
 *  - a KEYFRAME at the start of a segment the cadence asks for one at: the
 *    DomNode tree plus its `initial_state` seed, both taken on the shared
 *    capture span. Every other segment is a CONTINUATION of it (see
 *    `shouldKeyframe`)
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
  // Did the held root actually come from the configured selector? Resolving
  // once turns a transient miss into a permanent one, so the answer has to
  // reach the file rather than being assumed (see rootSelector below).
  var rootFromSelector = false;
  var root = resolveRoot();

  function resolveRoot() {
    var r = rec.config.root;
    if (typeof r === 'string' && r) {
      var found = null;
      try { found = doc.querySelector(r); } catch (e) { found = null; }
      if (found) { rootFromSelector = true; return found; }
      // A selector that matches nothing (or does not parse) is a study
      // misconfiguration, and the fallback is silent everywhere else: the
      // recording looks complete and simply describes a different subtree.
      rec.captureFailure('observed_root', new Error(
        'root selector "' + r + '" matched nothing at startSession(); ' +
        'observing document.body instead'));
      return doc.body;
    }
    return r || doc.body;
  }

  // Spec §2 types `observed_root` as a SELECTOR, and it must name what was
  // OBSERVED, not what was asked for. Returning the configured selector after
  // the fallback would put a body-rooted tree in a file labelled `#stage`, and
  // a conforming player honouring the field would mount it there.
  //
  // So: the configured selector only when the held root came from it; else the
  // root's own id; else null, which is §2's spelling for "the document body"
  // and exactly what the fallback observed. `null` alone would read as "the
  // researcher configured nothing", which is why the capture failure above is
  // the other half of this — together they are diagnosable.
  function rootSelector() {
    if (rootFromSelector) return rec.config.root;
    if (root && root.id) return '#' + root.id;
    return null;
  }

  rec.setObservedRoot(rootSelector());

  try {
    rec.setStylesheets(captureStylesheets(doc));
  } catch (e) { rec.captureFailure('stylesheets', e); }

  // ── Keyframe cadence (spec §3) ──
  //
  // A segment either opens a new keyframe span — a full snapshot, ids restarting
  // at 1 — or CONTINUES the current one, carrying `initial_dom: null` and
  // nothing else. `shouldKeyframe` above owns the decision and documents the
  // trigger; this is the bookkeeping it reads, one object per attachment, which
  // is one per recording.
  var cadence = {
    hasKeyframe: false, segments: 0, patchChars: 0, lastSnapshotChars: 0,
  };

  // Said once, at attach, rather than per segment: the fallback is refused for
  // a non-number (see `shouldKeyframe`), and silently recording a differently
  // shaped file is exactly what the strictness exists to prevent.
  var kfEvery = rec.config.keyframeEvery;
  if (kfEvery != null && typeof kfEvery !== 'number') {
    console.warn('[cyborg-hunter-replay] keyframeEvery must be a number; got ' +
      typeof kfEvery + ' (' + JSON.stringify(kfEvery) + '). The segment fallback ' +
      'is DISABLED for this recording — keyframes will be taken on accumulated ' +
      'patch size alone.');
  }

  rec.onTrialStart(function (trial) {
    // An IMPLICIT segment is opened RE-ENTRANTLY from inside `pushRecord`
    // (recorder.js's storeEvent), and the capture path doing that push has
    // ALREADY resolved its node ids against the current span — mapMutations for
    // a whole batch, targetFacts for one event — into records that are about to
    // be stored. A keyframe here calls `span.reset()`, so those ids name a span
    // the file no longer describes, and because a fresh pre-order walk reuses
    // the same small integers they do not dangle harmlessly: the player
    // resolves them against the new tree. Reproduced as a `dom.remove` that
    // deletes a node the participant never lost, and a `mouse.click` whose
    // `target` names a different element than its own `anchor.tag`. Strict
    // validation passes it — `node` fields are only number-checked.
    //
    // So an implicit segment always CONTINUES. The single exception is a span
    // with no keyframe at all, where §3 still forces one below — and in that
    // state the span holds nothing, so no id in flight can be stale: a mapped
    // batch produces no events, and a trace event's target already resolves to
    // null. (One consequence of that exception is recorded at recorder.js's
    // implicit-trial branch: the event that opens such a segment loses its
    // `target` id.)
    //
    // This is the only re-entrant path into `span.reset()`: its three call
    // sites are all in this hook, and `fireTrialStart` reaches it from
    // `startTrial` (host-driven, never re-entrant) and from `storeEvent`
    // (implicit only). Closing the implicit branch closes it for every capture
    // module at once, which a check inside any one module could not do.
    if (trial.implicit && cadence.hasKeyframe) {
      cadence.segments++;
      return;
    }
    if (!shouldKeyframe(cadence, rec.config.keyframeEvery)) {
      // A CONTINUATION. Nothing to do, and that is the point: the trial's
      // `initialDom`/`initialState` are already null (recorder.js), the span is
      // NOT reset, so every id the keyframe assigned stays valid and every node
      // the player holds stays held. A seed here would be wrong rather than
      // merely redundant — `initial_state` states what was true BEFORE a
      // keyframe (spec §3), and a continuation has no keyframe to precede.
      // The state it would re-state is already in the file as the patches and
      // events of the segments since, which the player has replayed by the time
      // it arrives here.
      cadence.segments++;
      return;
    }
    // A KEYFRAME. The order is a contract, not a preference: reset, then walk,
    // then seed. `span.reset()` restarts ids at 1 and empties the delivered
    // picture in one call (span.js — never `span.registry.resetSpan()` alone,
    // which silently loses nodes), the walk is the span's FIRST allocation so
    // the tree numbers 1..N, and the seed reads the ids that walk assigned.
    // Taken in any other order the seed names nodes the file does not contain.
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
        keyframeFailed();
      } else {
        trial.initialDom = tree;
        trial.initialState = seed;
        rec.noteSnapshotChars(trial, chars);
        cadence.hasKeyframe = true;
        cadence.segments = 1;
        cadence.patchChars = 0;
        cadence.lastSnapshotChars = chars;
      }
    } catch (e) {
      rec.captureFailure('dom_snapshot', e);
      trial.initialDom = null;
      trial.initialState = null;
      span.reset();
      keyframeFailed();
    }
  });

  // A keyframe that was dropped or threw leaves the file with no tree for this
  // span, so the next segment must take one rather than continue from nothing:
  // a continuation carrying dom.* patches before any keyframe is a recording no
  // player can reconstruct, and strict validation rejects it (spec §3).
  //
  // ONE of these four assignments has behaviour, and the reader is owed that
  // plainly. `hasKeyframe = false` is what forces the retry; the other three are
  // DEAD BY CONSTRUCTION and kept deliberately. Proof, not opinion: rule 1 of
  // `shouldKeyframe` short-circuits before reading `segments`, `patchChars` or
  // `lastSnapshotChars`, and the next keyframe that lands rewrites all four —
  // verified by inversion, since reducing this function to its single live line
  // passes the whole suite. They stay because they make the cadence state a true
  // description of the file (this span has no keyframe, so it has no segments,
  // no accumulated patches and no measured snapshot) and because they make the
  // retry singly-caused: without them the retry would still happen, from the
  // stale trigger values that asked for the failed keyframe, which is a
  // coincidence rather than a rule.
  //
  // Fault-injection consequence, so nobody reads the four as jointly guarded:
  // deleting this call altogether is NOT observable (the stale counters retry
  // anyway); deleting the `hasKeyframe` line alone IS, and is pinned.
  function keyframeFailed() {
    cadence.hasKeyframe = false;
    cadence.segments = 0;
    cadence.patchChars = 0;
    cadence.lastSnapshotChars = 0;
  }

  // ── Mutations (spec §5.1) ──
  if (MutationObserverImpl) {
    var handleBatch = function (records) {
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
        // What the span has cost in deltas so far (see `shouldKeyframe`).
        // Measured once per batch rather than once per patch: one stringify of
        // the array is the cheaper call and the closer estimate of what the
        // events cost as a group on the wire.
        if (events.length) cadence.patchChars += payloadChars(events);
      } catch (e) { rec.captureFailure('mutations', e); }
    };
    var observer = new MutationObserverImpl(handleBatch);
    try {
      observer.observe(root, MUTATION_OBSERVER_INIT);
      // Registered through the listener registry with the observer marker so
      // recorder.destroy() disconnects it (same convention as core monitor).
      rec.addListener(
        { addEventListener: function () {}, removeEventListener: function () {} },
        '_mutation_observer', observer, { _isObserver: true });
      // The observer callback is a MICROTASK, so DOM changes made in the same
      // task as stopSession() are still queued when the recording closes and
      // disconnecting drops them silently. Draining the queue through the SAME
      // handler is what makes the last thing a participant saw a patch rather
      // than a gap (T3 final review, F-5).
      rec.addPreCloseFlush(function () {
        var pending = observer.takeRecords();
        if (pending && pending.length) handleBatch(pending);
      });
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
