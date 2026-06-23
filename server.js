import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const root = path.dirname(url.fileURLToPath(import.meta.url));
const port = process.env.PORT || 5173;
const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url).pathname;
  const safePath = path.normalize(decodeURIComponent(parsed)).replace(/^([.][.][/\\])+/, '');
  let filePath = path.join(root, safePath === '/' ? 'index.html' : safePath);
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(port, () => console.log(`Kids maths app running at http://localhost:${port}`));
