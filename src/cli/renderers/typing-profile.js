// src/cli/renderers/typing-profile.js
// Renders per-participant typing speed bar chart using node-canvas.
// Each bar = one trial's chars/sec. A horizontal threshold line shows
// the configured CPS threshold. Bars above threshold are colored red.

import { writeFileSync } from 'fs';
import { join } from 'path';

const BAR_WIDTH = 30;
const BAR_GAP = 8;
const CHART_HEIGHT = 200;
const TOP_PAD = 50;
const BOTTOM_PAD = 50;
const LEFT_PAD = 60;

export async function renderTypingProfiles(participants, config) {
  const { createCanvas } = await import('canvas');

  for (const p of participants) {
    const trials = p.trials;
    if (trials.length === 0) continue;

    // Per-participant threshold line: prefer the typing-speed cutoff the library
    // actually screened this participant with (saved in session.config.thresholds)
    // so the red "fast typing" line matches summary.csv's count; fall back to the
    // CLI/default. A strict participant (8 cps) otherwise shows a 10 cps line.
    const threshold =
      p.session?.config?.thresholds?.typingSpeedCps ?? config.typingSpeedThreshold_cps ?? 10;

    // Per-trial state. We distinguish three cases:
    //   "typed"       — charsPerSec is a real number, draw a normal bar
    //   "paste-only"  — charsPerSec is null but there's a paste event; draw a
    //                   grey hatched marker so the absence is legible. Single
    //                   paste fires one input event → editTimestamps.length < 2
    //                   → computeTypingSpeed returns null. Without this, a
    //                   pasted response looks identical to a very slow one.
    //   "no-data"     — neither, leave blank
    const kinds = trials.map(t => {
      if (typeof t.charsPerSec === 'number') return 'typed';
      if ((t.pasteEvents || []).length > 0) return 'paste-only';
      return 'no-data';
    });
    const speeds = trials.map(t => (typeof t.charsPerSec === 'number' ? t.charsPerSec : 0));
    if (kinds.every(k => k === 'no-data')) continue;

    const canvasW = LEFT_PAD + trials.length * (BAR_WIDTH + BAR_GAP) + 20;
    const canvasH = TOP_PAD + CHART_HEIGHT + BOTTOM_PAD;
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');

    // Background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);

    // Title
    ctx.fillStyle = '#333';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`Typing Speed Profile — ${p.participantId}`, LEFT_PAD, 20);
    ctx.font = '10px sans-serif';
    ctx.fillStyle = '#666';
    ctx.fillText(`Threshold: ${threshold} chars/sec`, LEFT_PAD, 35);

    // Legend — three states documented in the `kinds` comment above.
    const legendY = 35;
    const legendX0 = LEFT_PAD + 180;
    ctx.fillStyle = '#2196F3';
    ctx.fillRect(legendX0, legendY - 8, 12, 10);
    ctx.fillStyle = '#666';
    ctx.fillText('typed', legendX0 + 16, legendY);
    ctx.fillStyle = '#f44336';
    ctx.fillRect(legendX0 + 60, legendY - 8, 12, 10);
    ctx.fillStyle = '#666';
    ctx.fillText('> threshold', legendX0 + 76, legendY);
    // Hatched swatch for paste-only
    drawHatchedRect(ctx, legendX0 + 150, legendY - 8, 12, 10);
    ctx.fillStyle = '#666';
    ctx.fillText('paste (P)', legendX0 + 166, legendY);

    // Y-axis scaling
    const maxSpeed = Math.max(...speeds, threshold * 1.5);
    const yScale = CHART_HEIGHT / maxSpeed;

    // Y-axis labels
    ctx.fillStyle = '#666';
    ctx.font = '9px sans-serif';
    const yTicks = 5;
    for (let t = 0; t <= yTicks; t++) {
      const val = (maxSpeed / yTicks) * t;
      const y = TOP_PAD + CHART_HEIGHT - val * yScale;
      ctx.fillText(`${val.toFixed(1)}`, 5, y + 3);
      // Grid line
      ctx.strokeStyle = '#eee';
      ctx.lineWidth = 0.5;
      ctx.beginPath();
      ctx.moveTo(LEFT_PAD, y);
      ctx.lineTo(canvasW - 10, y);
      ctx.stroke();
    }

    // Threshold line
    const threshY = TOP_PAD + CHART_HEIGHT - threshold * yScale;
    ctx.strokeStyle = '#ff0000';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 3]);
    ctx.beginPath();
    ctx.moveTo(LEFT_PAD, threshY);
    ctx.lineTo(canvasW - 10, threshY);
    ctx.stroke();
    ctx.setLineDash([]);

    // Bars
    const PASTE_BAR_H = CHART_HEIGHT * 0.2; // Paste-only marker height: fixed 20% of chart.
    for (let i = 0; i < trials.length; i++) {
      const kind = kinds[i];
      const speed = speeds[i];
      const x = LEFT_PAD + i * (BAR_WIDTH + BAR_GAP);

      if (kind === 'paste-only') {
        // Fixed-height hatched grey bar + "P" marker. The height is arbitrary
        // — the point is visible presence, not magnitude (we have no CPS to
        // show). Sits at the bottom like a normal bar.
        const y = TOP_PAD + CHART_HEIGHT - PASTE_BAR_H;
        drawHatchedRect(ctx, x, y, BAR_WIDTH, PASTE_BAR_H);
        ctx.strokeStyle = '#888';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, BAR_WIDTH, PASTE_BAR_H);
        // "P" marker above the bar
        ctx.fillStyle = '#555';
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText('P', x + BAR_WIDTH / 2 - 3, y - 3);
      } else if (kind === 'typed') {
        const barH = speed * yScale;
        const y = TOP_PAD + CHART_HEIGHT - barH;
        ctx.fillStyle = speed > threshold ? '#f44336' : '#2196F3';
        ctx.fillRect(x, y, BAR_WIDTH, barH);
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 0.5;
        ctx.strokeRect(x, y, BAR_WIDTH, barH);
        if (speed > 0) {
          ctx.fillStyle = '#fff';
          ctx.font = 'bold 9px sans-serif';
          ctx.fillText(speed.toFixed(1), x + 3, y + 12);
        }
        // Mixed: typed AND pasted in the same trial. The bar shows the typing
        // rate (legitimate signal); the "P" glyph above it flags that *some*
        // of the response came in via paste. Distinct from pure paste-only
        // (which is a hatched bar, no colored fill).
        if ((trials[i].pasteEvents || []).length > 0) {
          ctx.fillStyle = '#555';
          ctx.font = 'bold 11px sans-serif';
          ctx.fillText('P', x + BAR_WIDTH / 2 - 3, y - 3);
        }
      }
      // 'no-data' → render nothing (blank column)

      // Trial label (always drawn, even for blank columns)
      const trialId = trials[i].trialId || trials[i].ruleId || `T${i + 1}`;
      ctx.fillStyle = '#333';
      ctx.font = '8px sans-serif';
      ctx.save();
      ctx.translate(x + BAR_WIDTH / 2, TOP_PAD + CHART_HEIGHT + 10);
      ctx.rotate(Math.PI / 4);
      ctx.fillText(trialId.substring(0, 12), 0, 0);
      ctx.restore();
    }

    // Baseline
    ctx.strokeStyle = '#333';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(LEFT_PAD, TOP_PAD + CHART_HEIGHT);
    ctx.lineTo(canvasW - 10, TOP_PAD + CHART_HEIGHT);
    ctx.stroke();

    const buf = canvas.toBuffer('image/png');
    const filename = `typing_profile_${sanitize(p.participantId)}.png`;
    writeFileSync(join(config.outputDir, 'images', filename), buf);
  }

  console.log(`  typing profiles — rendered`);
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
}

// Cross-hatched fill for paste-only markers. Uses a light grey background
// with diagonal strokes so the bar reads as "distinct category, not zero".
function drawHatchedRect(ctx, x, y, w, h) {
  ctx.save();
  ctx.fillStyle = '#e8e8e8';
  ctx.fillRect(x, y, w, h);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = '#888';
  ctx.lineWidth = 0.8;
  const step = 5;
  for (let d = -h; d < w + h; d += step) {
    ctx.beginPath();
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
    ctx.stroke();
  }
  ctx.restore();
}
