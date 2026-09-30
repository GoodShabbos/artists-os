// HTTP router: maps method+path patterns to handlers.
const config = require('./config');
const db = require('./db');
const realtime = require('./realtime');
const { sendJson, sendError, readJsonBody, clientIp } = require('./http');

// --- CORS (same-origin by default; allow override for local dev) ----------
function applyCors(req, res) {
  const allow = process.env.CORS_ORIGIN;
  if (!allow) return;
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return true;
  }
  return false;
}

// --- Session resolution -----------------------------------------------------
// The session id rides in an X-Session-Id header from the frontend. If the id
// is unknown/expired we mint a fresh anonymous identity (no passwords ever).
function resolveSession(req, res) {
  const headerId = req.headers['x-session-id'];
  const displayName = req.headers['x-display-name'];
  const color = req.headers['x-color'];
  const row = db.upsertSession(headerId, displayName, color);
  // Echo back so the frontend can store the id on first call.
  res.setHeader('X-Session-Id', row.id);
  return row;
}

// --- Route table ------------------------------------------------------------
const routes = [];
const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

route('GET', '/health', async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    uptime: process.uptime(),
    visitors: db.activeVisitorCount(),
    realtimeClients: realtime.connectionCount(),
  });
});

// Anonymous session bootstrap.
route('POST', '/api/session', async (req, res) => {
  const body = (await readJsonBody(req, 4096)) || {};
  const row = db.upsertSession(body.sessionId, body.displayName, body.color);
  db.recordEvent('join', row.id, { name: row.display_name });
  realtime.broadcast('presence', { joined: row.id, name: row.display_name, visitors: db.activeVisitorCount() });
  sendJson(res, 201, {
    sessionId: row.id,
    displayName: row.display_name,
    color: row.color,
    createdAt: row.created_at,
  });
});

// Load saved workspace state (window layout, open apps).
route('GET', /^\/api\/session\/([\w-]+)\/state$/, async (req, res, m) => {
  const saved = db.getState(m[1]);
  if (!saved) return sendJson(res, 200, { state: null, updatedAt: null });
  sendJson(res, 200, saved);
});

// Persist workspace state.
route('PUT', /^\/api\/session\/([\w-]+)\/state$/, async (req, res, m) => {
  const body = await readJsonBody(req, config.maxBodyBytes);
  const sess = resolveSession(req, res);
  if (m[1] !== sess.id) return sendError(res, 403, 'Cannot write another visitor\'s state');
  db.saveState(sess.id, JSON.stringify(body && typeof body === 'object' ? body : {}));
  db.touchSession(sess.id);
  sendJson(res, 200, { ok: true, updatedAt: Date.now() });
});

// Save an artwork (data is a base64 data URL or raw bytes; meta is free-form).
route('POST', '/api/artifacts', async (req, res) => {
  const body = await readJsonBody(req, config.maxBodyBytes);
  if (!body || !body.data) return sendError(res, 400, 'Missing artwork data');
  const sess = resolveSession(req, res);
  const title = String(body.title || 'untitled').slice(0, 120);
  const kind = ['pixel', 'svg', 'png', 'note'].includes(body.kind) ? body.kind : 'pixel';
  let data;
  if (Buffer.isBuffer(body.data)) {
    data = body.data;
  } else if (typeof body.data === 'string') {
    const m = /^data:[^;]+;base64,(.*)$/s.exec(body.data);
    data = Buffer.from(m ? m[1] : body.data, 'base64');
  } else {
    return sendError(res, 400, 'data must be a string or buffer');
  }
  if (data.length === 0) return sendError(res, 400, 'Empty artwork payload');
  const art = db.createArtifact({ sessionId: sess.id, title, kind, data, meta: body.meta });
  db.recordEvent('artifact', sess.id, { id: art.id, title });
  realtime.broadcast('artifact', { id: art.id, title, kind, by: sess.display_name });
  sendJson(res, 201, art);
});

// Gallery listing (cursor = created_at of the oldest item seen).
route('GET', /^\/api\/artifacts$/, async (req, res) => {
  const qs = req.parsedUrl.searchParams;
  const items = db.listArtifacts(qs.get('limit'), qs.get('before'));
  sendJson(res, 200, { items });
});

// Fetch one artwork's binary payload.
route('GET', /^\/api\/artifacts\/([\w-]+)\/data$/, async (req, res, m) => {
  const row = db.getArtifactData(m[1]);
  if (!row) return sendError(res, 404, 'Not found');
  const mime = row.kind === 'png' ? 'image/png' : row.kind === 'svg' ? 'image/svg+xml' : 'application/json';
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' });
  res.end(row.data);
});

route('DELETE', /^\/api\/artifacts\/([\w-]+)$/, async (req, res, m) => {
  const sess = resolveSession(req, res);
  const got = db.getArtifactData(m[1]);
  if (!got) return sendError(res, 404, 'Not found');
  const metaOwner = db.db.prepare('SELECT session_id FROM artifacts WHERE id = ?').get(m[1]);
  if (metaOwner && metaOwner.session_id && metaOwner.session_id !== sess.id) {
    return sendError(res, 403, 'Not your artwork');
  }
  db.deleteArtifact(m[1]);
  db.recordEvent('artifact-delete', sess.id, { id: m[1] });
  realtime.broadcast('artifact-delete', { id: m[1] });
  sendJson(res, 200, { ok: true });
});

// Recent activity feed.
route('GET', '/api/events', async (req, res) => {
  sendJson(res, 200, { events: db.listEvents(30) });
});

// Server push stream: presence + new-artwork notifications.
route('GET', /^\/api\/realtime$/, async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: hello\ndata: ${JSON.stringify({ visitors: db.activeVisitorCount() })}\n\n`);
  realtime.addClient(res);
  const ping = setInterval(() => {
    try { res.write(`: ping\n\n`); } catch { clearInterval(ping); }
  }, config.ssePingMs);
  res.on('close', () => clearInterval(ping));
});

// --- Dispatch ---------------------------------------------------------------

// Patterns may be exact strings ('/health') or RegExp with capture groups.
function matchPattern(pattern, pathname) {
  if (typeof pattern === 'string') return pathname === pattern ? [pathname] : null;
  return pattern.exec(pathname);
}

async function handleApi(req, res, pathname) {
  if (applyCors(req, res) === true) return true;
  for (const { method, pattern, handler } of routes) {
    if (req.method !== method) continue;
    const m = matchPattern(pattern, pathname);
    if (!m) continue;
    try {
      await handler(req, res, m);
    } catch (err) {
      const status = err.statusCode || 500;
      if (status >= 500) console.error('[api]', err);
      if (!res.headersSent) sendError(res, status, err.message || 'Server error');
    }
    return true;
  }
  return false;
}

module.exports = { handleApi, resolveSession };