// Runtime configuration. Everything is env-overridable, nothing secret.
const path = require('node:path');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number.parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  // Where the SQLite file lives. data/ is gitignored.
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  // Static frontend is served from public/
  publicDir: process.env.PUBLIC_DIR || path.join(__dirname, '..', 'public'),
  // Max accepted JSON body (artwork payloads can be chunky): 5 MB.
  maxBodyBytes: Number.parseInt(process.env.MAX_BODY_BYTES || String(5 * 1024 * 1024), 10),
  // Sessions not seen for this long are reported inactive in presence counts.
  presenceWindowMs: Number.parseInt(process.env.PRESENCE_WINDOW_MS || String(5 * 60 * 1000), 10),
  // SSE keepalive ping so proxies don't drop idle streams.
  ssePingMs: Number.parseInt(process.env.SSE_PING_MS || String(25 * 1000), 10),
};

module.exports = config;