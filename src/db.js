// SQLite persistence layer using Node's built-in node:sqlite (no native deps).
// Schema: sessions (anonymous visitors), session_state (their saved OS layout),
// artifacts (saved artworks), events (recent activity feed).
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const config = require('./config');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new DatabaseSync(path.join(config.dataDir, 'artists-os.db'));

// Better concurrency defaults for a single process.
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA busy_timeout = 3000;');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    color TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_state (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'pixel',
    data BLOB NOT NULL,
    meta_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_artifacts_created ON artifacts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen_at DESC);
`);

// ---- ID/display helpers -------------------------------------------------

const PALETTE = ['#f94144', '#f3722c', '#f8961e', '#f9c74f', '#90be6d', '#43aa8b', '#577590', '#9b5de5', '#f15bb5', '#00bbf9'];
const CREATURES = ['squid', 'moth', 'slug', 'blob', 'wisp', 'gecko', 'crab', 'owl', 'newt', 'fox', 'urchin', 'beetle'];

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

function randomOf(arr) {
  return arr[crypto.randomInt(arr.length)];
}

// ---- Sessions ------------------------------------------------------------

// Insert the session row if absent; touch last_seen_at. Returns full row.
function upsertSession(sessionId, displayName, color) {
  const now = Date.now();
  if (sessionId) {
    const row = db
      .prepare('UPDATE sessions SET last_seen_at = ?, display_name = COALESCE(?, display_name), color = COALESCE(?, color) WHERE id = ? RETURNING *')
      .get(now, displayName || null, color || null, sessionId);
    if (row) return row;
  }
  const id = makeId('ses');
  const name = displayName || `anon ${randomOf(CREATURES)}`;
  const col = color || randomOf(PALETTE);
  return db.prepare('INSERT INTO sessions (id, display_name, color, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?) RETURNING *').get(id, name, col, now, now);
}

function touchSession(sessionId) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(Date.now(), sessionId);
}

function getSession(sessionId) {
  return db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
}

function activeVisitorCount() {
  const cutoff = Date.now() - config.presenceWindowMs;
  return db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE last_seen_at >= ?').get(cutoff).n;
}

// ---- Session workspace state (window layout etc.) -----------------------

function saveState(sessionId, stateJson) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO session_state (session_id, state_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`
  ).run(sessionId, stateJson, now);
}

function getState(sessionId) {
  const row = db.prepare('SELECT state_json, updated_at FROM session_state WHERE session_id = ?').get(sessionId);
  if (!row) return null;
  return { state: JSON.parse(row.state_json), updatedAt: row.updated_at };
}

// ---- Artifacts (saved artwork) --------------------------------------------

function createArtifact({ sessionId, title, kind, data, meta }) {
  const id = makeId('art');
  const now = Date.now();
  db.prepare('INSERT INTO artifacts (id, session_id, title, kind, data, meta_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, sessionId, title, kind, data, JSON.stringify(meta || {}), now);
  return db.prepare('SELECT id, session_id, title, kind, meta_json, created_at FROM artifacts WHERE id = ?').get(id);
}

function listArtifacts(limit = 60, before = null) {
  const lim = Math.min(Math.max(Number.parseInt(limit, 10) || 60, 1), 200);
  const rows = before
    ? db.prepare('SELECT id, session_id, title, kind, meta_json, created_at FROM artifacts WHERE created_at < ? ORDER BY created_at DESC LIMIT ?').all(Number.parseInt(before, 10), lim)
    : db.prepare('SELECT id, session_id, title, kind, meta_json, created_at FROM artifacts ORDER BY created_at DESC LIMIT ?').all(lim);
  return rows.map((r) => ({ ...r, meta: JSON.parse(r.meta_json) }));
}

function getArtifactData(id) {
  const row = db.prepare('SELECT data, kind FROM artifacts WHERE id = ?').get(id);
  return row || null;
}

function deleteArtifact(id) {
  return db.prepare('DELETE FROM artifacts WHERE id = ?').run().changes > 0;
}

// ---- Events (activity feed) ----------------------------------------------

function recordEvent(type, sessionId, payload) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO events (session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?)').run(sessionId || null, type, JSON.stringify(payload || {}), now);
  return { id: Number(info.lastInsertRowid), type, sessionId: sessionId || null, payload: payload || {}, createdAt: now };
}

function listEvents(limit = 30) {
  const rows = db.prepare('SELECT id, session_id AS sessionId, type, payload_json AS payload, created_at AS createdAt FROM events ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
}

// Lightweight housekeeping: drop very old events so the table can't grow forever.
function pruneEvents(maxAgeMs = 7 * 24 * 60 * 60 * 1000) {
  db.prepare('DELETE FROM events WHERE created_at < ?').run(Date.now() - maxAgeMs);
}

module.exports = {
  db,
  makeId,
  randomOf,
  upsertSession,
  touchSession,
  getSession,
  activeVisitorCount,
  saveState,
  getState,
  createArtifact,
  listArtifacts,
  getArtifactData,
  deleteArtifact,
  recordEvent,
  listEvents,
  pruneEvents,
  PALETTE,
};