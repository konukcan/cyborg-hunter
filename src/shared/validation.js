// src/shared/validation.js
// Config validation with "did you mean?" suggestions using Levenshtein distance.
// Used by both library init() and CLI config loading to catch typos early.

import { DEFAULT_CLI_CONFIG } from './schema.js';
import { DEFAULT_THRESHOLDS } from './constants.js';

// All recognized config keys across both browser library and CLI.
// Unknown keys trigger a warning with the closest match suggestion.
const ALL_KNOWN_KEYS = [
  'replayDir',
  ...Object.keys(DEFAULT_CLI_CONFIG),
  ...Object.keys(DEFAULT_THRESHOLDS),
  'preset', 'participantId', 'signals', 'thresholds', 'scoring',
  'domProtection', 'collectForPostHoc', 'onSignal', 'screenout',
  'experimentContainer', 'knownInputs', 'decoyAnswers', 'decoyMap',
  'decoyVisibility', 'decoyFraming', 'decoyExcludeButtons',
  'autoMonitor', 'excludeTrialTypes'
];

/**
 * Validates a config object against known keys.
 * Returns an array of warning strings for any unrecognized keys.
 * Each warning includes a "did you mean?" suggestion if a close match exists.
 */
export function validateConfig(config, knownKeys = ALL_KNOWN_KEYS) {
  const warnings = [];
  Object.keys(config).forEach(key => {
    if (!knownKeys.includes(key)) {
      const suggestion = findClosestKey(key, knownKeys);
      const msg = suggestion
        ? `Unknown config key "${key}" — did you mean "${suggestion}"?`
        : `Unknown config key "${key}"`;
      warnings.push(msg);
    }
  });
  return warnings;
}

/**
 * Validates the SHAPE of a merged scoring config, after preset+user overrides.
 * Returns warning strings for rules whose required numeric field is missing.
 *
 * Why this exists: scoring overrides replace each rule object wholesale
 * (Object.assign at the rule level), and validateConfig() only inspects
 * top-level keys. So a nested typo like `{hard:{paste:{countThreshhold:2}}}`
 * drops the real `countThreshold`, and `count >= undefined` is always false —
 * silently disabling a hard screenout rule with no warning. This catches that
 * class of misconfiguration: every hard rule needs a numeric countThreshold,
 * every soft rule a numeric weight. Valid overrides produce no warnings.
 */
export function validateScoringShape(scoring) {
  const warnings = [];
  if (!scoring || typeof scoring !== 'object') return warnings;
  // Number.isFinite (not typeof === 'number') so NaN and ±Infinity are also
  // flagged: typeof NaN === 'number', yet `count >= NaN` is always false (hard
  // rule silently off) and a NaN/Infinity weight breaks the soft score.
  // safeStr() is used in the message so a non-stringifiable value (e.g. a
  // Symbol, which template interpolation would throw on) still warns rather than
  // crashing the very validation meant to surface the misconfiguration.
  const hard = scoring.hard || {};
  Object.keys(hard).forEach(key => {
    const rule = hard[key];
    if (!rule || !Number.isFinite(rule.countThreshold)) {
      warnings.push(
        `scoring.hard.${key} has no finite numeric countThreshold (got ` +
        `${rule ? safeStr(rule.countThreshold) : 'no rule'}) — this hard ` +
        `screenout rule can never trigger. A likely cause is a typo in the ` +
        `override key (e.g. "countThreshhold").`
      );
    }
  });
  const soft = scoring.soft || {};
  Object.keys(soft).forEach(key => {
    const rule = soft[key];
    if (!rule || !Number.isFinite(rule.weight)) {
      warnings.push(
        `scoring.soft.${key} has no finite numeric weight (got ` +
        `${rule ? safeStr(rule.weight) : 'no rule'}) — this soft signal ` +
        `contributes nothing (or breaks the soft score). A likely cause is a ` +
        `typo in the override key (e.g. "wieght").`
      );
    }
  });
  return warnings;
}

// Coerce a value to a string for a warning message without ever throwing.
// String(Symbol()) throws; falling back to the typeof keeps the warning alive.
function safeStr(v) {
  try { return String(v); } catch (e) { return typeof v; }
}

/**
 * Finds the closest matching key using Levenshtein distance.
 * Returns null if no key is within edit distance 3 (too different to suggest).
 */
function findClosestKey(input, keys) {
  let best = null;
  let bestDist = Infinity;
  for (const key of keys) {
    const dist = levenshtein(input.toLowerCase(), key.toLowerCase());
    if (dist < bestDist && dist <= 3) {
      bestDist = dist;
      best = key;
    }
  }
  return best;
}

/**
 * Computes the Levenshtein (edit) distance between two strings.
 * Used for "did you mean?" suggestions on misspelled config keys.
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}
