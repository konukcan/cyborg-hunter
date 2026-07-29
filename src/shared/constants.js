// src/shared/constants.js
// Default thresholds and preset configurations for Cyborg Hunter.
// Single source of truth — used by both the browser library and CLI report tool.

export const VERSION = "0.7.1";

// Default detection thresholds shared across presets.
// Researchers can override any value at init() time.
export const DEFAULT_THRESHOLDS = {
  pasteMinChars: 0,            // record ALL pastes (was 20; now 0 by default)
  dropMinChars: 0,             // record ALL drops
  sidebarGapPx: 100,           // outerWidth - innerWidth above this = sidebar
  layoutCompressionPx: 20,     // innerWidth - clientWidth above scrollbar width
  viewportShiftDebounceMs: 250, // quiet period before a viewport-width shift is logged (one gesture = one event)
  syntheticGapMs: 100,         // keydown-to-input gap above this = synthetic insertion
  idleGapMs: 10000,            // no input for this long = idle gap
  idleCheckIntervalMs: 5000,   // how often to check for idle gaps
  mouseThrottleMs: 50,         // 20 Hz mouse sampling
  mouseMaxEvents: 2000,        // safety cap per trial (configurable)
  mouseBotMinEvents: 3,        // minimum move events for bot metrics
  sidebarPollMs: 2000,         // sidebar + zoom check interval
  extensionScanMs: 30000,      // AI extension DOM re-scan interval
  windowPositionPollMs: 2000,  // screenX/screenY polling interval
  elementTraceHz: 500,         // elementsFromPoint sampling interval (ms)
  tabAwayDurationMs: 3000,     // tab-away longer than this counts toward soft score (and is classified as "long" in reports)
  typingSpeedCps: 10           // chars/sec above this counts toward soft score
};

// Named detection + scoring configurations.
// Architecture:
//   signals    — what to COLLECT (always-on by default; disable for GDPR-sensitive signals)
//   thresholds — detection parameters (when does an event "count"?)
//   scoring    — two-tier screenout system:
//                  hard: count-based, any one crossing its threshold = screenout
//                  soft: weighted accumulation with a separate threshold
//   screenout  — master switch + grace period
export const PRESETS = {
  permissive: {
    // Collect everything, screen out nobody. For calibration/pilot studies.
    signals: {
      paste: true, copy: true, drop: true, tabAway: true, typingSpeed: true,
      devTools: true, aiExtensions: true, sidebarGap: true,
      keyboardShortcuts: true, mouseTracking: true, idleGaps: true,
      windowPosition: true, clipboardManager: true,
      keystrokeDynamics: false  // GDPR: off by default
    },
    thresholds: {
      typingSpeedCps: 15       // more lenient typing speed threshold
    },
    scoring: {
      hard: {
        paste: { countThreshold: 3 },
        drop:  { countThreshold: 3 }
      },
      soft: {
        copy:         { weight: 1, maxPerTrial: 2 },
        tabAway:      { weight: 1, maxPerTrial: 2 },
        typingSpeed:  { weight: 1 },
        sidebarEvent: { weight: 1 },
        devTools:     { weight: 1 },
        foreignInput: { weight: 1 }
      },
      softScoreThreshold: 10
    },
    screenout: { enabled: false, gracePeriodTrials: 5 }
  },
  standard: {
    // Balanced detection. Default for most studies.
    signals: {
      paste: true, copy: true, drop: true, tabAway: true, typingSpeed: true,
      devTools: true, aiExtensions: true, sidebarGap: true,
      keyboardShortcuts: true, mouseTracking: true, idleGaps: true,
      windowPosition: true, clipboardManager: true,
      keystrokeDynamics: false  // GDPR: off by default
    },
    thresholds: {},  // uses DEFAULT_THRESHOLDS as-is
    scoring: {
      hard: {
        paste: { countThreshold: 2 },
        drop:  { countThreshold: 2 }
      },
      soft: {
        copy:         { weight: 2, maxPerTrial: 2 },
        tabAway:      { weight: 1, maxPerTrial: 2 },
        typingSpeed:  { weight: 2 },
        sidebarEvent: { weight: 3 },
        devTools:     { weight: 1 },
        foreignInput: { weight: 2 }
      },
      softScoreThreshold: 6
    },
    screenout: { enabled: true, gracePeriodTrials: 3 }
  },
  strict: {
    // Low thresholds, all signals. For high-stakes studies.
    signals: {
      paste: true, copy: true, drop: true, tabAway: true, typingSpeed: true,
      devTools: true, aiExtensions: true, sidebarGap: true,
      keyboardShortcuts: true, mouseTracking: true, idleGaps: true,
      windowPosition: true, clipboardManager: true,
      keystrokeDynamics: true
    },
    thresholds: {
      typingSpeedCps: 8,       // stricter typing speed
      tabAwayDurationMs: 5000, // shorter tab-away counts
      mouseMaxEvents: 5000     // larger cap for detailed analysis
    },
    scoring: {
      hard: {
        paste: { countThreshold: 1 },
        copy:  { countThreshold: 2 },
        drop:  { countThreshold: 1 }
      },
      soft: {
        tabAway:      { weight: 2, maxPerTrial: 1 },
        typingSpeed:  { weight: 3 },
        sidebarEvent: { weight: 2 },
        devTools:     { weight: 2 },
        foreignInput: { weight: 3 }
      },
      softScoreThreshold: 4
    },
    screenout: { enabled: true, gracePeriodTrials: 2 }
  }
};

// AI extension selectors — used by browser detection to find known AI tools
// in the DOM. Each entry has a human-readable name and a CSS selector.
export const AI_SELECTORS = [
  // ChatGPT extensions
  { name: "ChatGPT sidebar",     sel: "chatgpt-sidebar" },
  { name: "ChatGPT extension",   sel: "[data-chatgpt]" },
  // Copilot browser extension (not Edge's built-in)
  { name: "Copilot extension",   sel: "copilot-suggestions" },
  { name: "Copilot extension",   sel: "[data-copilot]" },
  // Gemini browser extension (not Chrome's built-in)
  { name: "Gemini extension",    sel: "gemini-panel" },
  // Claude browser extension
  { name: "Claude extension",    sel: "[data-claude-extension]" },
  // Popular AI extensions
  { name: "Monica AI",           sel: "monica-root" },
  { name: "Merlin AI",           sel: "merlin-root" },
  { name: "Sider AI",            sel: "[data-sider-extension]" },
  { name: "MaxAI",               sel: "[data-maxai]" },
  // Generic AI assistant marker
  { name: "AI assistant",        sel: "[data-ai-assistant]" },
  // AI iframes (extensions embedding AI services)
  { name: "AI iframe (OpenAI)",     sel: 'iframe[src*="chat.openai.com"]' },
  { name: "AI iframe (Copilot)",    sel: 'iframe[src*="copilot.microsoft.com"]' },
  { name: "AI iframe (Gemini)",     sel: 'iframe[src*="gemini.google.com"]' },
  { name: "AI iframe (Claude)",     sel: 'iframe[src*="claude.ai"]' },
  { name: "AI iframe (Perplexity)", sel: 'iframe[src*="perplexity.ai"]' }
];

// Benign extension tags to exclude from MutationObserver alerts.
// These are known non-AI extensions that commonly inject DOM elements.
export const BENIGN_TAGS = [
  "grammarly", "lastpass", "1password", "bitwarden",
  "dashlane", "roboform", "honey", "ublock", "adblock"
];


// Filesystem/CSS-safe participant-id sanitizer. Single source of truth for
// every artifact filename (browser persistence, CLI ingest, report assets)
// — divergent copies caused a live fallback-path mismatch (autoreview 0.7.0).
export function sanitizeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_.-]/g, '_');
}
