// Connection to the multiplayer relay (server/relay.mjs). Resolves once the relay has
// put us in a room: { id, code, isHost, send(str), close(), onmessage(str), onclose(reason) }.
export function openRelay(url, hello) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(url); } catch (e) { reject(new Error('Bad server address')); return; }
    let ready = false;
    const conn = {
      id: -1, code: '', isHost: false, onmessage: null, onclose: null,
      send(s) { if (ws.readyState === 1) ws.send(s); },
      close() { conn.onclose = null; try { ws.close(); } catch (e) {} },
    };
    const fail = msg => { if (ready) return; ready = true; clearTimeout(timer); try { ws.close(); } catch (e) {} reject(new Error(msg)); };
    const timer = setTimeout(() => fail('Server did not respond'), 8000);
    ws.onopen = () => ws.send(JSON.stringify(hello));
    ws.onerror = () => fail('Could not reach server');
    ws.onclose = ev => {
      if (!ready) { fail('Connection closed'); return; }
      if (conn.onclose) conn.onclose(ev.code === 4001 ? 'Host left the game' : 'Lost connection to server');
    };
    ws.onmessage = ev => {
      if (ready) { if (conn.onmessage) conn.onmessage(String(ev.data)); return; }
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.t === 'error') { fail(m.msg || 'Server refused'); return; }
      if (m.t !== 'welcome') return;
      ready = true; clearTimeout(timer);
      conn.id = m.id; conn.code = m.code; conn.isHost = m.id === 0;
      resolve(conn);
    };
  });
}
