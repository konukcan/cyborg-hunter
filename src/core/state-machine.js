// src/core/state-machine.js
// Lifecycle state machine enforcing correct call order:
// init → startSession → startTrial/endTrial → destroy
// States: "created", "session", "trial", "destroyed"

// Valid state transitions. Each state maps to an array of states it can
// transition to. Any other transition is rejected with a warning.
export const VALID_TRANSITIONS = {
  created:   ["session", "destroyed"],
  session:   ["trial", "destroyed"],
  trial:     ["session", "destroyed"],  // endTrial returns to session
  destroyed: []
};

/**
 * Creates a state machine instance.
 * Returns an object with a `current` getter and a `transition(to)` method.
 * transition() returns true on success, false on invalid transition.
 */
export function createStateMachine() {
  let state = "created";
  return {
    get current() { return state; },
    transition(to) {
      if (VALID_TRANSITIONS[state] && VALID_TRANSITIONS[state].indexOf(to) !== -1) {
        state = to;
        return true;
      }
      console.warn("[cyborg-hunter] invalid transition: " + state + " → " + to);
      return false;
    }
  };
}

/**
 * Deep copy utility — prevents external mutation of internal state.
 * Uses JSON round-trip for simplicity. Falls back to identity for
 * non-serializable objects (shouldn't happen in practice).
 */
export function deepCopy(obj) {
  if (obj === null || typeof obj !== "object") return obj;
  try { return JSON.parse(JSON.stringify(obj)); }
  catch (e) { return obj; }
}

/**
 * Storage helpers with localStorage/sessionStorage fallback.
 * Some browsers disable localStorage in private browsing mode,
 * so we fall back to sessionStorage, then to no-op.
 */
export const STORAGE_PREFIX = "integrity_monitor_";

export function storageSet(key, value) {
  var fullKey = STORAGE_PREFIX + key;
  try {
    localStorage.setItem(fullKey, JSON.stringify(value));
  } catch (e) {
    // localStorage unavailable (private browsing) — try sessionStorage
    try {
      sessionStorage.setItem(fullKey, JSON.stringify(value));
    } catch (e2) { /* both unavailable — in-memory only */ }
  }
}

export function storageGet(key) {
  var fullKey = STORAGE_PREFIX + key;
  try {
    var raw = localStorage.getItem(fullKey);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through */ }
  try {
    var raw2 = sessionStorage.getItem(fullKey);
    if (raw2) return JSON.parse(raw2);
  } catch (e) { /* fall through */ }
  return null;
}

export function storageClear(participantId) {
  var prefix = STORAGE_PREFIX + participantId;
  [localStorage, sessionStorage].forEach(function (store) {
    try {
      for (var i = store.length - 1; i >= 0; i--) {
        var k = store.key(i);
        if (k && k.startsWith(prefix)) store.removeItem(k);
      }
    } catch (e) { /* non-critical */ }
  });
}
