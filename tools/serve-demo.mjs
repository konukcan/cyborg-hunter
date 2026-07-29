// tools/serve-demo.mjs
// Dependency-free static file server for the assembled demo site
// (.demo-site/), used only by the Playwright webServer during `npm run
// test:e2e`. No express/serve-handler — this is ~30 lines of node:http.
//
// Usage: node tools/serve-demo.mjs [port] [rootDir]
//   defaults: port 8177, rootDir .demo-site/ (relative to repo root)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.argv[2]) || 8177;
const ROOT = process.argv[3] || join(__dirname, '..', '.demo-site');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer(async (req, res) => {
  var urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  // normalize() collapses ".." segments so a crafted request path can't
  // escape ROOT; re-joining onto ROOT below is still required since
  // normalize() alone doesn't stop a leading "../" from resolving upward.
  var safePath = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  var filePath = join(ROOT, safePath);

  try {
    var st = await stat(filePath);
    if (st.isDirectory()) filePath = join(filePath, 'index.html');
    var body = await readFile(filePath);
    var type = CONTENT_TYPES[extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found: ' + urlPath);
  }
});

server.listen(PORT, () => {
  console.log('serve-demo: http://localhost:' + PORT + ' -> ' + ROOT);
});
