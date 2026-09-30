// Static file server for public/ with path-traversal protection.
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

const ROOT = path.resolve(config.publicDir);

function serveStatic(req, res, pathname) {
  // Strip query, decode, and refuse anything escaping public/.
  let rel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    res.writeHead(400).end('Bad request');
    return true;
  }
  if (rel.includes('..') || path.isAbsolute(rel)) {
    res.writeHead(400).end('Bad request');
    return true;
  }
  let filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return true;
  }
  let stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    stat = fs.existsSync(filePath) ? fs.statSync(filePath) : null;
  }
  if (!stat) {
    // SPA-ish fallback: any unknown non-API GET gets index.html.
    if ((req.headers.accept || '').includes('text/html')) {
      filePath = path.join(ROOT, 'index.html');
      if (!fs.existsSync(filePath)) return false;
      stat = fs.statSync(filePath);
    } else {
      return false;
    }
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

module.exports = { serveStatic };