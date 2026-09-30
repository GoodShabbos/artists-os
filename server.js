// artists-os backend entry point.
const http = require('node:http');
const config = require('./src/config');
const { handleApi } = require('./src/router');
const { serveStatic } = require('./src/static');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  req.parsedUrl = url;

  if (pathname === '/health' || pathname.startsWith('/api/') || pathname === '/api/realtime') {
    const handled = await handleApi(req, res, pathname);
    if (!handled && !res.headersSent) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
    return;
  }

  // Everything else is the frontend.
  const handled = serveStatic(req, res, pathname);
  if (!handled && !res.headersSent) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
});

// Housekeeping every hour: prune old events.
const pruneTimer = setInterval(() => {
  try {
    const removed = require('./src/db').pruneEvents();
    if (removed && removed.changes) console.log(`[prune] removed ${removed.changes} old events`);
  } catch (err) {
    console.error('[prune]', err.message);
  }
}, 60 * 60 * 1000);
pruneTimer.unref();

server.listen(config.port, config.host, () => {
  console.log(`artists-os backend on http://${config.host}:${config.port} (${config.env})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}