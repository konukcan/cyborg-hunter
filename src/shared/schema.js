// src/shared/schema.js
// Defines the expected shape of integrity data for validation.
// Used by the CLI ingest step and for documentation generation.

// The fields that appear in a trial report from endTrial().
// 'required' means the field must be present for valid integrity data.
export const TRIAL_REPORT_FIELDS = {
  trialId: { type: 'string', required: true },
  phase: { type: 'string', required: false },
  libraryVersion: { type: 'string', required: true },
  participantId: { type: 'string', required: true },
  startTime: { type: 'number', required: true },
  duration_ms: { type: 'number', required: true },
  pasteEvents: { type: 'array', required: true },
  copyEvents: { type: 'array', required: true },
  dropEvents: { type: 'array', required: true },
  editTimestamps: { type: 'array', required: false },
  charsPerSec: { type: 'number', required: false },
  tabAwayEvents: { type: 'array', required: true },
  idleGaps: { type: 'array', required: false },
  mouseEvents: { type: 'array', required: false },
  mouseMetrics: { type: 'object', required: false },
  extensionsDetected: { type: 'array', required: false },
  sidebarGapPx: { type: 'number', required: false },
  foreignInputEvents: { type: 'array', required: false },
  syntheticInsertions: { type: 'array', required: false },
  decoy: { type: 'object', required: false },
  trialSoftScore: { type: 'number', required: true },
  trialSignals: { type: 'object', required: true }
};

// Default config for the CLI report tool.
// All fields have sensible defaults — minimal config is just dataDir + filePattern.
export const DEFAULT_CLI_CONFIG = {
  dataDir: "./data",
  replayDir: null,             // replay artifacts dir; defaults to dataDir
  filePattern: "*.json",
  participantIdField: "participantId",
  trialIdField: "trialId",
  trialOrderField: "trialIndex",
  integrityField: "integrity",
  sessionIntegrityPath: null,
  trialsPerParticipant: null,
  platformIdField: null,
  showPlatformId: false,
  conditionField: null,
  groupField: null,
  typingSpeedThreshold_cps: 10,
  tabAwayMinDuration_ms: 3000,
  idleGapThreshold_ms: 10000,
  suspiciouslyFastRT_ms: 2000,
  scoring: null,  // uses library defaults
  signals: null,  // all enabled
  phaseScope: null,  // {include: [...], exclude: [...]} — scope scores to phases
  trajectoryGrid: "auto",
  trajectoryTrialLabel: "trialId",
  trajectoryResponseField: null,
  trajectoryDisplayOrder: "rule",
  outputDir: "./cyborg-hunter-report",
  outputFormat: "html"
};
