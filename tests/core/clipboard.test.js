// tests/core/clipboard.test.js
// Pins independent gating of the drop signal.
//
// Fresh-eyes fix (2026-07-04): the drop listener was attached under
// `if (config.signals.paste)` — a copy-paste error. Disabling paste
// silently disabled drop (a separately hard-scored signal). Presets now
// declare `drop` explicitly and the listener is gated on it.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { attachClipboardSignals } from '../../src/core/signals/clipboard.js';
import { PRESETS } from '../../src/shared/constants.js';

// attachClipboardSignals references the global `document` only as a listener
// target handed to ctx.addTrialListener, so an empty object suffices in node.
beforeEach(() => { globalThis.document = {}; });

function fakeCtx(signals) {
  const attached = [];
  return {
    attached,
    config: {
      signals,
      thresholds: { pasteMinChars: 0, dropMinChars: 0 },
      collectForPostHoc: { pasteDropContent: false },
    },
    trialData: { pasteEvents: [], copyEvents: [], dropEvents: [] },
    sessionData: { pasteCount: 0, copyCount: 0, dropCount: 0 },
    addTrialListener: (target, event, handler) => attached.push(event),
    fireSignal: () => {},
    isKnownInput: () => null,
  };
}

describe('drop signal gating', () => {
  it('attaches the drop listener when drop is enabled and paste is disabled', () => {
    const ctx = fakeCtx({ paste: false, copy: false, drop: true });
    attachClipboardSignals(ctx);
    assert.ok(ctx.attached.includes('drop'),
      'drop must be attachable independently of paste');
    assert.ok(!ctx.attached.includes('paste'));
  });

  it('does not attach the drop listener when drop is explicitly disabled', () => {
    const ctx = fakeCtx({ paste: true, copy: false, drop: false });
    attachClipboardSignals(ctx);
    assert.ok(!ctx.attached.includes('drop'),
      'explicit drop:false must win even when paste is on');
    assert.ok(ctx.attached.includes('paste'));
  });

  it('every preset declares drop explicitly', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      assert.strictEqual(preset.signals.drop, true,
        `preset "${name}" must declare drop: true`);
    }
  });
});
