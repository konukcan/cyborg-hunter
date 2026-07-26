// =============================================================================
// recording-trial.js
//
// Custom jsPsych v7 plugin: press-space audio recording trial.
//
// Replaces the broken `html-audio-response` trial. The jsPsych v7 plugin
// requires `initialize-microphone` first AND has unrelated `addEventListener`
// failures at our pinned SHA. Rather than fight the plugin, we build a custom
// plugin directly on `MediaRecorder` + `getUserMedia`, modelled on the
// hard-won audio-recorder state machine of an earlier internal experiment
// (below: the reference recorder).
//
// Spacebar flow:
//   First Space  → request mic permission, start MediaRecorder.
//   Second Space → stop MediaRecorder, capture audio as base64, end trial.
//
// State machine (port of the reference recorder's 5 states):
//   idle → pending_permission → recording → stopping → finished | error
//
// Defenses ported from the reference recorder:
//   - onstop 5s timeout (MediaRecorder.onstop can fail to fire on some
//     browsers/recorders; force-finalize so the trial never wedges).
//   - try/catch around .stop(), new MediaRecorder(...), and .start().
//   - FileReader.readAsDataURL for blob → base64 (no
//     `btoa(String.fromCharCode(...))` stack-overflow footgun on large blobs).
//   - beforeunload handler so a mid-recording tab close still releases the
//     mic stream.
//   - `finalized` flag guards against double-finish (onstop fires AFTER the
//     timeout has already finalized — rare but documented).
//
// Trial data emitted:
//   - audio_base64: string | null
//   - duration_ms: number
//   - mime_type: string | null
//   - mic_permission_granted: boolean
//   - error: string | null  (one of:
//       'permission_denied' | 'no_microphone' |
//       'recorder_construct_failed' | 'stop_threw' | 'onstop_timeout' |
//       'filereader_error')
//
// v0.1 limitation: audio is base64-inlined in the jsPsych CSV. At ~150-300KB
// per recording × a small number of v0.1 human runs, the DataPipe payload
// stays well under the 10MB cap. v0.2 should refactor to upload audio as a
// separate `_audio.webm` DataPipe file.
//
// ParameterType import: in production, `jsPsychModule.ParameterType` is the
// enum exposed by jsPsych core. Under Node test the file still needs to load
// without crashing on a missing global, so we fall back to plain strings.
// =============================================================================

const ParameterType = globalThis.jsPsychModule?.ParameterType ?? {
  HTML_STRING: 'html_string',
  INT: 'int',
};

export class RecordingTrialPlugin {
  static info = {
    name: 'bench-recording-trial',
    parameters: {
      stimulus:          { type: ParameterType.HTML_STRING, default: undefined },
      prompt:            { type: ParameterType.HTML_STRING, default: 'Press SPACE to start recording. Press SPACE again to stop. (Max 30 seconds.)' },
      max_duration_ms:   { type: ParameterType.INT, default: 30000 },
      onstop_timeout_ms: { type: ParameterType.INT, default: 5000 },
    },
  };

  constructor(jsPsych) {
    this.jsPsych = jsPsych;
  }

  trial(display_element, trial) {
    // === State (port of the reference recorder's 5-state machine) ===
    // idle → pending_permission → recording → stopping → finished | error
    let state = 'idle';
    let mediaRecorder = null;
    let stream = null;
    const chunks = [];
    let startTime = null;
    let elapsedTimer = null;
    let maxDurationTimer = null;
    let onstopTimer = null;
    let finalized = false; // guards double-finish (onstop AFTER timeout)

    // === Render ===
    display_element.innerHTML = `
      <div class="bench-recording-trial">
        ${trial.stimulus}
        <p class="prompt">${trial.prompt}</p>
        <div class="rec-indicator" style="display:none; color:#c00; margin-top:8px;">
          <span class="dot" style="display:inline-block; width:10px; height:10px;
                                   background:#c00; border-radius:50%; vertical-align:middle;
                                   margin-right:6px; animation:rec-pulse 1s infinite;"></span>
          Recording... <span class="elapsed">0.0</span>s
        </div>
      </div>
    `;

    // === Cleanup (call from any terminal state) ===
    const cleanup = () => {
      if (elapsedTimer)     { clearInterval(elapsedTimer); elapsedTimer = null; }
      if (maxDurationTimer) { clearTimeout(maxDurationTimer); maxDurationTimer = null; }
      if (onstopTimer)      { clearTimeout(onstopTimer); onstopTimer = null; }
      if (stream) {
        stream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
        stream = null;
      }
      document.removeEventListener('keydown', onSpace);
      window.removeEventListener('beforeunload', onUnload);
    };

    // === Finalize once: write data, call jsPsych.finishTrial, never re-enter ===
    const finalize = (data) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      display_element.innerHTML = '';
      this.jsPsych.finishTrial(data);
    };

    const finalizeError = (error_code, partial = {}) => {
      state = 'error';
      finalize({
        audio_base64: null,
        duration_ms: startTime != null ? performance.now() - startTime : 0,
        mime_type: null,
        mic_permission_granted: error_code === 'permission_denied' ? false : (stream != null),
        error: error_code,
        ...partial,
      });
    };

    // === Page-unload guard: clean up if participant closes tab mid-recording ===
    const onUnload = () => {
      if (state === 'recording' || state === 'stopping') {
        try { mediaRecorder && mediaRecorder.stop(); } catch (_) {}
      }
      cleanup();
    };
    window.addEventListener('beforeunload', onUnload);

    // === Convert Blob → base64 via FileReader (reference-recorder pattern; no stack overflow) ===
    const blobToBase64 = (blob) => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        // dataURL = "data:audio/webm;base64,XXXX..." — strip prefix.
        const dataUrl = String(reader.result);
        const commaIdx = dataUrl.indexOf(',');
        if (commaIdx < 0) return reject(new Error('filereader_unexpected_format'));
        resolve(dataUrl.slice(commaIdx + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('filereader_error'));
      reader.readAsDataURL(blob);
    });

    // === MediaRecorder onstop handler ===
    const handleStop = async () => {
      if (state !== 'stopping') return; // race guard
      if (onstopTimer) { clearTimeout(onstopTimer); onstopTimer = null; }

      const mime = mediaRecorder?.mimeType || 'audio/webm';
      const duration_ms = performance.now() - startTime;

      try {
        const blob = new Blob(chunks, { type: mime });
        const audio_base64 = await blobToBase64(blob);
        state = 'finished';
        finalize({
          audio_base64,
          duration_ms,
          mime_type: mime,
          mic_permission_granted: true,
          error: null,
        });
      } catch (err) {
        finalizeError('filereader_error', { duration_ms, mime_type: mime });
      }
    };

    // === Stop the recorder safely (try/catch + onstop timeout per the reference recorder) ===
    const stopRecorder = () => {
      if (state !== 'recording') return;
      state = 'stopping';
      try {
        mediaRecorder.stop();
      } catch (err) {
        finalizeError('stop_threw');
        return;
      }
      // The reference recorder learned the hard way: MediaRecorder.onstop can fail to fire.
      // Safety timeout — if onstop doesn't run, force-finalize.
      onstopTimer = setTimeout(() => {
        if (!finalized) finalizeError('onstop_timeout');
      }, trial.onstop_timeout_ms);
    };

    // === Spacebar handler ===
    const onSpace = async (event) => {
      if (event.code !== 'Space' || event.repeat) return;
      event.preventDefault();

      if (state === 'idle') {
        state = 'pending_permission';
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
          // NotAllowedError → permission denied; NotFoundError → no mic present.
          const code = err && err.name === 'NotFoundError' ? 'no_microphone' : 'permission_denied';
          return finalizeError(code);
        }

        const preferredMime = 'audio/webm;codecs=opus';
        const mime = (typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(preferredMime))
          ? preferredMime : 'audio/webm';

        try {
          mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
        } catch (err) {
          return finalizeError('recorder_construct_failed');
        }

        mediaRecorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };
        mediaRecorder.onstop = handleStop;
        mediaRecorder.onerror = () => {
          if (state === 'recording') stopRecorder();
        };

        try {
          mediaRecorder.start(100); // 100ms chunk cadence (reference-recorder default)
        } catch (err) {
          return finalizeError('recorder_construct_failed');
        }

        startTime = performance.now();
        state = 'recording';

        const indicator = display_element.querySelector('.rec-indicator');
        if (indicator) indicator.style.display = 'block';
        elapsedTimer = setInterval(() => {
          const sec = ((performance.now() - startTime) / 1000).toFixed(1);
          const el = display_element.querySelector('.elapsed');
          if (el) el.textContent = sec;
        }, 100);

        // Auto-stop after max_duration_ms — guards against forgetting to press space.
        maxDurationTimer = setTimeout(() => {
          if (state === 'recording') stopRecorder();
        }, trial.max_duration_ms);

      } else if (state === 'recording') {
        stopRecorder();
      }
      // ignore Space in pending_permission / stopping / finished / error states
    };

    document.addEventListener('keydown', onSpace);
  }
}

/**
 * Build a jsPsych trial that uses the RecordingTrialPlugin.
 *
 * @param {object} opts
 * @param {string} opts.cardImage - URL/path to the card stimulus image.
 * @returns {object} A jsPsych trial object.
 */
export function buildRecordingTrial({ cardImage }) {
  return {
    type: RecordingTrialPlugin,
    stimulus:
      `<img src="${cardImage}" alt="card stimulus" style="display:block;margin:auto;">` +
      `<p>Describe this card:</p>`,
    prompt: 'Press SPACE to start recording. Press SPACE again to stop. (Max 30 seconds.)',
    max_duration_ms: 30000,
  };
}
