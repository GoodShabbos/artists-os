// End-to-end smoke test: boots nothing, assumes server is already running
// (npm start in another terminal, or npm run smoke right after start).
// Run: node scripts/smoke.js  (BASE_URL env optional, default http://localhost:3000)

const BASE = process.env.BASE_URL || 'http://localhost:3000';

async function j(method, path, body, headers = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

let passed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { console.error(`  FAIL ${name}${detail ? ' — ' + JSON.stringify(detail) : ''}`); process.exitCode = 1; }
}

// 1. health
{
  const { status, json } = await j('GET', '/health');
  check('GET /health → 200 ok', status === 200 && json.ok === true, json);
}

// 2. session bootstrap (anonymous, twice to prove persistence path)
{
  const first = await j('POST', '/api/session', {});
  check('POST /api/session → 201 with id', first.status === 201 && typeof first.json.sessionId === 'string', first.json);
  const again = await j('POST', '/api/session', { sessionId: first.json.sessionId });
  check('session re-boot returns same id', again.json.sessionId === first.json.sessionId, again.json);
}

// 3. state round-trip
{
  const s = await j('POST', '/api/session', {});
  const id = s.json.sessionId;
  const put = await j('PUT', `/api/session/${id}/state`, { windows: [{ app: 'paint', x: 10, y: 20 }] }, { 'X-Session-Id': id });
  check('PUT state → ok', put.status === 200 && put.json.ok === true, put.json);
  const get = await j('GET', `/api/session/${id}/state`);
  check('GET state returns saved layout', get.json.state?.windows?.[0]?.app === 'paint', get.json);
  const other = await j('PUT', `/api/session/${id}/state`, { x: 1 }, { 'X-Session-Id': 'ses_someoneelse' });
  check('cannot write someone else\'s state', other.status === 403, other.json);
}

// 4. artifacts
{
  const s = await j('POST', '/api/session', {});
  const id = s.json.sessionId;
  const pngB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
  const make = await j('POST', '/api/artifacts', {
    title: 'smoke-test blob', kind: 'png', sessionId: undefined,
    data: `data:image/png;base64,${pngB64}`,
    meta: { w: 2, h: 2 },
  }, { 'X-Session-Id': id });
  check('POST /api/artifacts → 201', make.status === 201 && typeof make.json.id === 'string', make.json);
  const list = await j('GET', '/api/artifacts?limit=5');
  check('GET /api/artifacts lists it', list.json.items.some((a) => a.id === make.json.id), list.json.items?.[0]);
  const bin = await fetch(`${BASE}/api/artifacts/${make.json.id}/data`);
  const buf = Buffer.from(await bin.arrayBuffer());
  check('artifact data round-trips as PNG bytes', buf[0] === 0x89 && bin.status === 200, bin.status);
  const del = await j('DELETE', `/api/artifacts/${make.json.id}`, null, { 'X-Session-Id': id });
  check('DELETE artifact → ok', del.status === 200 && del.json.ok === true, del.json);
}

// 5. events + realtime endpoint exists
{
  const ev = await j('GET', '/api/events');
  check('GET /api/events → array', ev.status === 200 && Array.isArray(ev.json.events), typeof ev.json);
  const rt = await fetch(`${BASE}/api/realtime`);
  check('GET /api/realtime is an SSE stream', rt.headers.get('content-type')?.includes('text/event-stream'), rt.headers.get('content-type'));
  await rt.body?.cancel().catch(() => {});
}

// 6. static frontend
{
  const { status, headers } = await j('GET', '/');
  check('GET / serves HTML', status === 200 && headers.get('content-type').includes('text/html'));
  const bad = await j('GET', '/../../etc/passwd');
  check('path traversal blocked', bad.status === 400 || bad.status === 403 || bad.status === 404, bad.status);
}

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);