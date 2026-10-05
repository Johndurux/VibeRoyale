// Minimal static server for local play. The game is a no-build vanilla ES
// module project, so all it needs is correct MIME types over HTTP -- opening
// index.html as a file:// URL fails, because the import map and every relative
// import are blocked by the file:// origin.
//
// Serves this directory only, and refuses to walk out of it.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const path = join(ROOT, rel === '' ? 'index.html' : rel);

  // Path traversal guard: anything resolving outside ROOT is refused.
  if (!path.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404');
  }
});

server.listen(PORT, () => {
  console.log(`VibeRoyale serving ${ROOT}`);
  console.log(`  http://localhost:${PORT}/`);
});