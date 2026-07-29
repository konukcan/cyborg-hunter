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
  lc.transitionTo('s2');
  assert.strictEqual(lc.isOpen(), true);
  lc.transitionTo('s3'); lc.transitionTo(null);
  assert.strictEqual(lc.isOpen(), false);
  lc.transitionTo('s9');
  assert.deepStrictEqual(calls, [['start','s2'],['end'],['start','s3'],['end'],['start','s9']]);
});

it('transitionTo the same trialId twice in a row still closes then reopens', () => {
  const calls = [];
  const monitor = {
    _open: false,
    startTrial(o){ if (this._open) throw new Error('invalid lifecycle call');
                   this._open = true; calls.push(['start', o.trialId]); },
    endTrial(){ if (!this._open) return null; this._open = false; calls.push(['end']); },
  };
  const lc = makeLifecycle(monitor);
  lc.transitionTo('same'); lc.transitionTo('same');
  assert.deepStrictEqual(calls, [['start','same'],['end'],['start','same']]);
});

it('onTrialReport receives each closed trial\'s report, and nothing when no trial was open', () => {
  const reports = [];
  let seq = 0;
  const monitor = {
    _open: false,
    startTrial(){ this._open = true; },
    endTrial(){ if (!this._open) return null; this._open = false; seq++; return { trialId: 'r' + seq }; },
  };
  const lc = makeLifecycle(monitor, { onTrialReport: (r) => reports.push(r) });
  lc.transitionTo('a');   // nothing open yet -> no report
  lc.transitionTo('b');   // closes 'a' -> report r1
  lc.transitionTo(null);  // closes 'b' -> report r2
  lc.transitionTo(null);  // nothing open -> no report
  assert.deepStrictEqual(reports, [{ trialId: 'r1' }, { trialId: 'r2' }]);
});
