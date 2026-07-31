// Shared demo helpers. escHtml is load-bearing for safety: stream rows and
// the results walkthrough render visitor-triggered text (pasted strings).
export function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
