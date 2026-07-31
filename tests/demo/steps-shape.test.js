// tests/demo/steps-shape.test.js
// Structural contract the engine relies on: 13 steps, known ids in order,
// every step has eyebrow/title/body, exactly one honeypot step (provisional),
// no tier vocabulary before step 11 (G2 guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STEPS, RAIL_GROUPS, CODE_TABS, REPLICATE, FINISH_VARIANTS } from '../../demo/steps.js';

const IDS = ['intro','baseline','clipboard-cheat','tab-away','browser-rearrange',
  'autotype','honeypot','guard-entry','guard-cheat','guard-debrief',
  'signals-to-scores','results','replicate-locally'];

test('step map', () => {
  assert.equal(STEPS.length, 13);
  assert.deepEqual(STEPS.map(s => s.id), IDS);
  for (const s of STEPS) { assert.ok(s.eyebrow && s.title && s.body, s.id); }
});
test('G2: no tier vocabulary before the scores step', () => {
  const before = STEPS.slice(0, 10).map(s => [s.title, s.body, JSON.stringify(s.task || {})].join(' ')).join(' ');
  for (const word of ['HARD', 'SOFT', 'CLEAN', 'tier', 'triage', 'preset']) {
    assert.ok(!before.includes(word), `"${word}" leaked before step 11`);
  }
});
test('rail has three tab-away bins', () => {
  const keys = RAIL_GROUPS.detectors.map(d => d.key);
  for (const k of ['tabAwayFlicker', 'tabAwayMid', 'tabAwayLong']) assert.ok(keys.includes(k), k);
});
test('exports the engine consumes exist', () => {
  assert.ok(CODE_TABS.jspsych && CODE_TABS.plainjs);
  assert.ok(Array.isArray(REPLICATE.sections) && REPLICATE.sections.length >= 3);
  assert.ok(FINISH_VARIANTS.full && FINISH_VARIANTS.act2Skipped && FINISH_VARIANTS.zeroLamp);
});
