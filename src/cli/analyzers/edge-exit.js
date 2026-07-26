// src/cli/analyzers/edge-exit.js
// Detects the "edge-exit" mouse pattern: mouse moves to window edge just before
// a tab-away event, then returns from the same edge region after the tab.
//
// This pattern suggests the participant switched to a side-by-side lookup window
// (ChatGPT, notes, etc.) rather than accidentally clicking away. The algorithm:
//   1. For each tab-away event, find mouse events in the 2s before it
//   2. Check if the last mouse position was near a screen edge (within 50px)
//   3. Record which edge (left/right) and the coordinates

const EDGE_MARGIN = 50;   // pixels from window edge to count as "near edge"
const TIME_WINDOW = 2000;  // ms — how far back to look for edge proximity

export function detectEdgeExits(participants, config) {
  return participants.map(p => ({
    participantId: p.participantId,
    edgeExits: p.trials.map(t => detectEdgeExitForTrial(t, config))
  }));
}

export function detectEdgeExitForTrial(trial, config) {
  const mouse = trial.mouseEvents || [];
  const tabAways = trial.tabAwayEvents || [];
  // Use reported window width, or fall back to config, or assume 1920
  const width = config.width || trial.windowWidth || 1920;

  let edgeExitCount = 0;
  const events = [];

  for (const ta of tabAways) {
    // Modern ingest normalizes tab-away starts to trial-relative startRel_ms;
    // mouse t is already trial-relative, so both must use the same base.
    // Legacy payloads (no startRel_ms) carried trial-relative start directly.
    const taStart = ta.startRel_ms ?? ta.start;
    // Find mouse move events in the TIME_WINDOW before this tab-away
    const beforeTA = mouse.filter(m =>
      m.type === 'move' && m.t < taStart && m.t > taStart - TIME_WINDOW);

    if (beforeTA.length === 0) continue;

    // Check if the last mouse position before tab-away was near an edge
    const lastBefore = beforeTA[beforeTA.length - 1];
    const nearLeftEdge = lastBefore.x < EDGE_MARGIN;
    const nearRightEdge = lastBefore.x > width - EDGE_MARGIN;

    if (nearLeftEdge || nearRightEdge) {
      edgeExitCount++;
      events.push({
        tabAwayStart: taStart,
        tabAwayDuration: ta.duration_ms,
        exitEdge: nearLeftEdge ? 'left' : 'right',
        exitX: lastBefore.x,
        exitY: lastBefore.y
      });
    }
  }

  return { edgeExitCount, events };
}
