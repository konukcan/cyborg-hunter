import { it } from 'node:test';
import assert from 'node:assert';
import { makeLifecycle } from '../../demo/lifecycle.js';

it('close-then-open is idempotent across advance/back/skip', () => {
  const calls = [];
  const monitor = {
    _open: false,
    startTrial(o){ if (this._open) throw new Error('invalid lifecycle call');
                   this._open = true; calls.push(['start', o.trialId]); },
    endTrial(){ if (!this._open) return null; this._open = false; calls.push(['end']); },
  };
  const lc = makeLifecycle(monitor);
  lc.transitionTo('s2'); lc.transitionTo('s3'); lc.transitionTo(null); lc.transitionTo('s9');
  assert.deepStrictEqual(calls, [['start','s2'],['end'],['start','s3'],['end'],['start','s9']]);
});
