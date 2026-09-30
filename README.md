# artists-os — backend

A zero-dependency Node.js backend for **artists-os**: a browser-based art OS with
no passwords, anonymous visitors, draggable windows, and a canvas soul.

- **Runtime**: Node ≥ 22.5 (uses built-in `node:sqlite`) — `npm install` not needed.
- **Storage**: SQLite (WAL) at `data/artists-os.db`.
- **Realtime**: Server-Sent Events for presence + gallery activity.
- **Static**: serves `public/` (the OS frontend drops in here).

## Run

```bash
npm start          # node server.js → http://localhost:3000
npm run dev        # auto-restart on change
npm run smoke      # end-to-end API checks (server must be running)
```

Configuration via env (see `.env.example`): `PORT`, `HOST`, `DATA_DIR`,
`PUBLIC_DIR`, `MAX_BODY_BYTES`, `PRESENCE_WINDOW_MS`, `SSE_PING_MS`, `CORS_ORIGIN`.

## API

All requests/responses are JSON unless noted. Identify yourself with the
`X-Session-Id` header (value comes from `POST /api/session`). No auth — sessions
are anonymous tokens minted server-side and kept by the browser.

### `GET /health`
`200 { ok, uptime, visitors, realtimeClients }`

### `POST /api/session`
Anonymous bootstrap. Body (all optional): `{ sessionId?, displayName?, color? }`.
Pass a previously returned `sessionId` to keep the same identity across reloads.
Returns `201 { sessionId, displayName, color, createdAt }`.
Broadcasts a `presence` SSE event and records a `join` activity event.

### `GET /api/session/:id/state`
Returns `200 { state, updatedAt }` — the saved workspace (window layout, open
apps, …) or `{ state: null, updatedAt: null }` if never saved.

### `PUT /api/session/:id/state`
Body: any JSON (≤ `MAX_BODY_BYTES`). Only the owning session may write
(`X-Session-Id` must match) → `403` otherwise. Returns `200 { ok, updatedAt }`.

### `POST /api/artifacts`
Save artwork. Body: `{ title?, kind?, data, meta? }` where `kind` ∈
`pixel | svg | png | note` and `data` is a base64 string or `data:` URL
(decoded server-side). Returns `201 { id, sessionId, title, kind, meta, createdAt }`.
Broadcasts an `artifact` SSE event. Errors: `400` missing/empty/invalid data.

### `GET /api/artifacts?limit=&before=`
Gallery listing, newest first. `limit` 1–200 (default 60), `before` = `createdAt`
cursor for pagination. Returns `200 { items: [...] }` (data payloads excluded —
fetch them individually).

### `GET /api/artifacts/:id/data`
Raw bytes of one artifact. `Content-Type` depends on `kind`
(`image/png`, `image/svg+xml`, `application/json`). `404` if unknown.

### `DELETE /api/artifacts/:id`
Owner-only (`X-Session-Id` must match creator). `200 { ok }` / `403` / `404`.
Broadcasts `artifact-delete`.

### `GET /api/events`
Last 30 activity events: `200 { events: [{ id, sessionId, type, payload, createdAt }] }`.

### `GET /api/realtime`
Server-Sent Events stream. Events: `hello` (with `visitors` count), `presence`
(joins), `artifact` (new artwork saved), `artifact-delete`. Keepalive `: ping`
every 25 s.

CORS: off by default; set `CORS_ORIGIN` (e.g. `http://localhost:5173`) for a
separately-hosted frontend dev server.

## Layout

```
server.js            entry: HTTP server, routing split, graceful shutdown
src/config.js        env-driven settings
src/db.js            node:sqlite schema + all queries
src/http.js          body parsing (size-capped), JSON senders
src/router.js        route table, session resolution, CORS, error mapping
src/realtime.js      SSE client registry + broadcast
src/static.js        public/ file server with traversal protection
public/index.html    tiny placeholder OS window (drag it — proves the API)
scripts/smoke.js     end-to-end checks against a running server
```

## Data model

| table           | purpose                                          |
| --------------- | ------------------------------------------------ |
| `sessions`      | anonymous visitors (display name + color)        |
| `session_state` | per-visitor persisted workspace JSON             |
| `artifacts`     | saved artworks (binary payload + free-form meta) |
| `events`        | activity feed (auto-pruned after 7 days)         |

## Docker

```bash
docker build -t artists-os-backend .
docker run -p 3000:3000 -v "$(pwd)/data:/app/data" artists-os-backend
```