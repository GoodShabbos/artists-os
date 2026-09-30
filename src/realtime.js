// In-memory registry of connected SSE clients + broadcast helper.
// Presence is rebuilt from the sessions table counts, so this only tracks
// live streams.

const clients = new Set();

function addClient(res) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

function broadcast(event, payload = {}) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\nid: ${Date.now()}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

function connectionCount() {
  return clients.size;
}

module.exports = { addClient, broadcast, connectionCount };