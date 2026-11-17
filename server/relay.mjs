// Tollgate Tactical relay: a tiny WebSocket "post office" for multiplayer rooms.
// It never runs game logic. The host's browser simulates the match; this server only
// creates 4-letter room codes and forwards messages between the host and its players.
//
//   host   -> server : "*|<json>"      broadcast to every player in the room
//                      "<id>|<json>"   send to one player
//                      "!<id>|<json>"  send to everyone except one player
//   player -> server : "<json>"        always delivered to the host as "<id>|<json>"
//   server -> host   : "S|<json>"      room events: {t:'join', id, name} / {t:'leave', id}
//
// Run:  node server/relay.mjs        (PORT env var, default 8787)
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 8787;
const MAX_PEERS = 8;              // host + 7 players = full 4v4
const MAX_BUFFER = 2 * 1024 * 1024; // a player this far behind is dropped rather than desynced
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const rooms = new Map();          // code -> { code, host, peers: Map<id, ws>, next }

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
  res.end(`tollgate relay ok · ${rooms.size} room(s)\n`);
});
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

function newCode() {
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += ALPHA[(Math.random() * ALPHA.length) | 0];
    if (!rooms.has(c)) return c;
  }
}
function send(ws, s) {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > MAX_BUFFER) { ws.terminate(); return; }
  ws.send(s);
}
const json = o => JSON.stringify(o);

wss.on('connection', ws => {
  let room = null, id = -1;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', data => {
    const s = data.toString();
    if (!room) { // first message is the hello: host a room or join one
      let m; try { m = JSON.parse(s); } catch { ws.close(4002, 'bad hello'); return; }
      if (m && m.t === 'host') {
        room = { code: newCode(), host: ws, peers: new Map(), next: 1 };
        rooms.set(room.code, room); id = 0;
        send(ws, json({ t: 'welcome', id, code: room.code }));
      } else if (m && m.t === 'join') {
        const r = rooms.get(String(m.code || '').toUpperCase().trim());
        if (!r) { send(ws, json({ t: 'error', msg: 'Room not found' })); ws.close(); return; }
        if (r.peers.size + 1 >= MAX_PEERS) { send(ws, json({ t: 'error', msg: 'Room is full' })); ws.close(); return; }
        room = r; id = r.next++; r.peers.set(id, ws);
        send(ws, json({ t: 'welcome', id, code: r.code }));
        send(r.host, 'S|' + json({ t: 'join', id, name: String(m.name || '').slice(0, 16) }));
      } else ws.close(4002, 'bad hello');
      return;
    }
    if (id !== 0) { send(room.host, id + '|' + s); return; }
    const bar = s.indexOf('|');
    if (bar < 0) return;
    const to = s.slice(0, bar), body = s.slice(bar + 1);
    if (to === '*') for (const p of room.peers.values()) send(p, body);
    else if (to[0] === '!') { const ex = Number(to.slice(1)); for (const [pid, p] of room.peers) if (pid !== ex) send(p, body); }
    else { const p = room.peers.get(Number(to)); if (p) send(p, body); }
  });

  ws.on('close', () => {
    if (!room) return;
    if (id === 0) {
      rooms.delete(room.code);
      for (const p of room.peers.values()) p.close(4001, 'Host left');
    } else {
      room.peers.delete(id);
      send(room.host, 'S|' + json({ t: 'leave', id }));
    }
  });
});

// drop dead connections (phones that lost signal, closed laptops)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 15000);

server.listen(PORT, () => console.log(`tollgate relay listening on :${PORT}`));
