// tests/core/dom-protection.test.js
// Pins decoy trial-index reset across monitor instances.
//
// Fresh-eyes fix (2026-07-04): _decoyTrialIndex is module-scoped and survived
// across CyborgHunter.init() calls, so a second session in the same page load
// continued the cal-{N} numbering instead of restarting at 1. init() must
// reset it via resetDecoyState().

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { injectDecoy, resetDecoyState } from '../../src/core/signals/dom-protection.js';

// Minimal DOM stub: injectDecoy (level 1 path) only needs createElement and
// body.appendChild.
let appended;
beforeEach(() => {
  appended = [];
  globalThis.document = {
    createElement: () => {
      const el = { style: {}, attrs: {}, textContent: '' };
      el.setAttribute = (k, v) => { el.attrs[k] = v; };
      return el;
    },
    body: { appendChild: (el) => appended.push(el) },
    getElementById: () => null,
    querySelectorAll: () => [],
  };
});

function inject(trialId) {
  const trialData = { trialId };
  injectDecoy(
    { decoyAnswer: 'the moon is made of cheese' },
    trialId,
    { decoyAnswers: true, decoyFraming: 'calibration-metadata', decoyVisibility: 'offscreen' },
    trialData,
    () => trialData,
  );
}

describe('decoy trial-index reset', () => {
  it('resetDecoyState() restarts cal-{N} numbering at 1', () => {
    resetDecoyState();
    inject('t1');
    inject('t2');
    assert.match(appended[1].textContent, /cal-2/,
      'second injection in a session numbers cal-2');

    resetDecoyState();          // what init() must call for a fresh instance
    inject('t1-second-session');
    assert.match(appended[2].textContent, /cal-1/,
      'a fresh session must restart numbering at cal-1');
  });
});
