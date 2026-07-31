// demo/tests/blob-iframe.spec.js
// The one mechanism §7.3 stakes the payoff on, verified on all three
// engines: blob: URL into sandbox="allow-scripts" iframe — scripts execute,
// data-URI images render. Runs against a minimal inline harness page (not
// the full tour) so Firefox/WebKit stay fast.
import { test, expect } from '@playwright/test';

const PNG1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('blob URL + allow-scripts sandbox executes scripts and shows data-URI images', async ({ page }) => {
  await page.goto('about:blank');
  await page.setContent('<div id="host"></div>');
  await page.evaluate(function (png) {
    var html = '<p id="marker">static</p><img id="im" src="' + png + '">' +
      '<script>document.getElementById("marker").textContent = "script-ran";</script>';
    var iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.src = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    document.getElementById('host').appendChild(iframe);
  }, PNG1x1);
  const frame = page.frameLocator('#host iframe');
  await expect(frame.locator('#marker')).toHaveText('script-ran');
  await expect(frame.locator('#im')).toBeVisible();
});
