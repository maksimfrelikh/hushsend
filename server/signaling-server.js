// signaling-server.js
// Mesh-capable WebRTC signaling relay. PURE signaling — never carries application data.
//
// ROOM MODEL
//   - filetransfer: rooms are CREATED, not picked. "Create" makes the server allocate a
//     fresh unused 4-digit code (returned in `welcome`); the creator shares it. "Join"
//     enters an EXISTING code — the server never creates a room on join, so a typo / expired
//     code yields "room not found" instead of a ghost room. This kills accidental crowding
//     on memorable codes (1234/0000), since nobody picks the code anymore.
//     NOTE: a 4-digit code stops *accidental* collisions but is not unguessable — a scanner
//     can enumerate the 10k space. MITM is still stopped by the client-side SAS; lengthen the
//     code (see filetransfer.allocate) if you also want rooms to be unfindable by strangers.
//     Inside a room it is a small LOBBY: the user picks who to open a 1:1 transfer with; the
//     transfer is 1:1 and may fall back to coturn (configured client-side in iceServers).
//   - clipboard: shared-clipboard mesh. KEEPS the shared-code model (joinMayCreate) — your
//     own devices type the same code on purpose. NO server fallback (pure P2P + gossip).
//
// Peer ids are human-readable words (e.g. "brave-otter") — a LABEL, not proof of identity.
// The real "no MITM" guarantee is the SAS/PAKE anchor on the CLIENT, not the name. The
// origin/room checks and the caps below are HYGIENE / anti-DoS, NOT authn: the server is
// assumed untrusted; all confidentiality/authenticity lives client-side.
//
// Signaling is ADDRESSED (routed to one peer), so the same server serves a 1:1 pick inside a
// lobby and a full mesh alike.
//
// Protocol (JSON text frames):
//   server -> peer:  { type:'welcome', selfId, room, peers:[...ids] }
//                    { type:'peer-joined', peerId } | { type:'peer-left', peerId }
//   peer  -> server: { type:'signal', to:<id>, data:<opaque> }
//   server forwards: { type:'signal', from:<id>, data:<opaque> }
// Connect URL: ?app=<id>&create=1   (allocate a new room)  OR  ?app=<id>&room=<code> (join)
//
// DEPLOYMENT (front + back on one host behind nginx):
//   - Bind to loopback (HOST=127.0.0.1, default below) so the only thing that can reach Node
//     is nginx on the same host. Nothing external hits Node directly, so no one can inject a
//     fake X-Real-IP by bypassing the proxy.
//   - Set TRUST_PROXY=1 and have nginx set `X-Real-IP $remote_addr` (see the bundled nginx
//     conf). clientIp() then reads that, NOT the client-controllable leftmost X-Forwarded-For.
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { randomInt } from 'crypto';
import { WORDLIST } from './wordlist.js'; // server's OWN copy (client/server share no code)
const PORT         = Number(process.env.PORT) || 8080;
const HOST         = process.env.HOST || '127.0.0.1'; // loopback — only the local nginx reaches us
const HEARTBEAT_MS = Number(process.env.PING_MS) || 30000;
const MAX_PAYLOAD  = Number(process.env.MAX_PAYLOAD) || 64 * 1024; // SDP/ICE are small; 64KB is plenty
const DEV          = process.env.NODE_ENV !== 'production';
const TRUST_PROXY  = process.env.TRUST_PROXY === '1'; // 1 when behind nginx/LB — see clientIp() + nginx conf
const TRUSTED_PROXY_HOPS = Number(process.env.TRUSTED_PROXY_HOPS) || 1; // reverse-proxy hops you run (nginx = 1)
// Resource caps (anti-DoS). App-level limits that COMPLEMENT, not replace, OS/proxy limits.
const MAX_CONNS_TOTAL     = Number(process.env.MAX_CONNS_TOTAL)     || 5000;
const MAX_CONNS_PER_IP    = Number(process.env.MAX_CONNS_PER_IP)    || 20;
const MAX_PER_IP_PER_ROOM = Number(process.env.MAX_PER_IP_PER_ROOM) || 2;   // stops one IP filling a lobby
const MAX_ROOMS           = Number(process.env.MAX_ROOMS)           || 2000;
const ALLOC_TRIES         = 50;                                             // free-code search attempts
const MSG_WINDOW_MS       = Number(process.env.MSG_WINDOW_MS)       || 10000;
const MSG_SOFT_LIMIT      = Number(process.env.MSG_SOFT_LIMIT)      || 100;  // over → drop (don't relay)
const MSG_HARD_LIMIT      = Number(process.env.MSG_HARD_LIMIT)      || 300;  // over → close (clear flood)
// "words" method hardening (codeType=word ONLY — the 4-digit room/link/QR path is untouched).
// Bounds online guessing of the 4 secret words: a word room is strictly 1:1 (so guesses are
// serialized) and self-destructs after a short TTL (so a leaked rendezvous can't be farmed).
const WORD_ROOM_MAX_PEERS = 2;                                              // creator + one joiner
const WORD_ROOM_TTL_MS    = Number(process.env.WORD_ROOM_TTL_MS)    || 180000; // ~3 min from creation
const devOrigins = DEV ? ['http://localhost:5173'] : [];
// base32-ish alphabet without ambiguous chars (no 0/o/1/l), for longer codes if needed.
const SAFE32 = 'abcdefghijkmnpqrstuvwxyz23456789';
const randStr = (n, alphabet = SAFE32) =>
  Array.from({ length: n }, () => alphabet[randomInt(alphabet.length)]).join('');
// "words" method rendezvous: a PUBLIC room id drawn from EFF short #2. Membership lookup
// (handles e.g. "yo-yo") instead of a regex, since we own the authoritative list anyway.
const WORD_SET = new Set(WORDLIST);
const pickWord = () => WORDLIST[randomInt(WORDLIST.length)];
const APPS = {
  // hushsend.frelikh.dev — create/join, 1:1 transfer inside a small lobby (coturn fallback client-side)
  filetransfer: {
    maxPeers: Number(process.env.FILETRANSFER_MAX_PEERS) || 8,
    code: /^\d{4}$/,                                  // 4-digit rendezvous label (NOT a secret)
    allocate: () => String(randomInt(10000)).padStart(4, '0'),  // ← lengthen here for unguessable codes
    // Parallel "words" rendezvous (?codeType=word). The 4-digit path is UNCHANGED —
    // room/link/QR keep using `code`/`allocate`; only the words method asks for a word.
    wordCode: {
      valid: (s) => WORD_SET.has(s),                  // membership, not regex (covers "yo-yo")
      allocate: () => pickWord(),                      // one PUBLIC word from EFF short #2
    },
    joinMayCreate: false,                             // join must hit an EXISTING room
    origins: ['https://hushsend.frelikh.dev', ...devOrigins],
  },
  // hushclip.frelikh.dev — shared-clipboard mesh, shared code among own devices, no fallback
  clipboard: {
    maxPeers: Number(process.env.CLIPBOARD_MAX_PEERS) || 8,
    code: /^[A-Za-z0-9-]{1,32}$/,                     // bounded; tighten to your client's format
    allocate: () => randStr(6),                       // only used if a client sends create=1
    joinMayCreate: true,                              // first device creates the room by joining
    origins: ['https://hushclip.frelikh.dev', ...devOrigins],
  },
};
// Readable id parts. ids are labels, NOT secrets, so plain word picks are fine.
const ADJECTIVES = ['brave','calm','swift','bright','quiet','clever','gentle','bold','lucky','merry','eager','jolly','keen','neat','proud','witty','sunny','cozy','mellow','nimble','plucky','snappy','spry','zesty','breezy','chipper','dapper','frosty','golden','hardy','jovial','lively','peppy','quirky','rustic','silky','tidy','upbeat','vivid','wily'];
const ANIMALS    = ['otter','fox','panda','koala','lynx','robin','heron','finch','gecko','tapir','bison','ibex','lemur','narwhal','quokka','raccoon','walrus','badger','beaver','falcon','marmot','ocelot','pelican','puffin','wombat','alpaca','bobcat','cardinal','dolphin','ferret','gopher','hedgehog','iguana','jaguar','kestrel','mongoose','newt','osprey','raven','sparrow'];
const pick = (arr) => arr[randomInt(arr.length)];
// unique readable id within a room (so addressing `to` stays unambiguous)
function makeReadableId(peers) {
  for (let i = 0; i < 20; i++) {
    const id = `${pick(ADJECTIVES)}-${pick(ANIMALS)}`;
    if (!peers.has(id)) return id;
  }
  let id; // ultra-rare collision fallback
  do { id = `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${randomInt(100)}`; } while (peers.has(id));
  return id;
}
// allocate a fresh code not currently in use for this app (atomic: handler is synchronous).
// `allocate` is the per-codeType generator (4-digit for room/link/QR, a word for "words").
function allocateCode(app, allocate) {
  for (let i = 0; i < ALLOC_TRIES; i++) {
    const c = allocate();
    if (!rooms.has(`${app}:${c}`)) return c;
  }
  return null; // space too crowded
}
// Resolve the code shape (validator + allocator) for this connection's codeType. The default
// is the app's 4-digit `code`/`allocate`; `?codeType=word` selects the optional word rendezvous.
function codeSpec(cfg, codeType) {
  if (codeType === 'word' && cfg.wordCode) return cfg.wordCode;
  return { valid: (s) => cfg.code.test(s), allocate: cfg.allocate };
}
// Strip the IPv6-mapped-IPv4 prefix so "::ffff:203.0.113.7" is counted as "203.0.113.7".
function normalizeIp(ip) {
  if (!ip) return 'unknown';
  ip = String(ip).trim();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  return m ? m[1] : ip;
}
// Real client IP, used for the per-IP caps. Behind a proxy we must NOT trust the LEFTMOST
// X-Forwarded-For entry — that's whatever the client sent, and an appending proxy (nginx's
// $proxy_add_x_forwarded_for) leaves it client-controlled, which would let one attacker rotate
// fake IPs and slip every per-IP cap (then only MAX_CONNS_TOTAL is left). We trust ONLY what
// our own proxy sets:
//   1) X-Real-IP  (nginx: `proxy_set_header X-Real-IP $remote_addr;` overwrites any client value)
//   2) else the XFF entry our proxy appended: the Nth from the RIGHT (N = TRUSTED_PROXY_HOPS).
function clientIp(req) {
  if (TRUST_PROXY) {
    const real = req.headers['x-real-ip'];
    if (real) return normalizeIp(Array.isArray(real) ? real[0] : real);
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
      const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
      const fromRight = parts[parts.length - TRUSTED_PROXY_HOPS];
      if (fromRight) return normalizeIp(fromRight);
    }
  }
  return normalizeIp(req.socket.remoteAddress);
}
const rooms    = new Map(); // "appId:code" -> Map<peerId, ws>
const roomMeta = new Map(); // "appId:code" -> { creatorId, timer } — word rooms ONLY (TTL + destroy)
const ipCounts = new Map(); // ip -> live connection count (global per-IP cap)
// Invalidate a word room: notify its members (except an optional initiator), close their
// sockets, free the rendezvous word, and cancel the TTL. Used by the TTL timer (reason
// 'expired') and the creator's destroy command (reason 'destroyed'). Safe to call once.
function closeWordRoom(key, reason, exceptId) {
  const meta = roomMeta.get(key);
  if (meta && meta.timer) clearTimeout(meta.timer);
  roomMeta.delete(key);
  const peers = rooms.get(key);
  if (!peers) return;
  rooms.delete(key); // free the word immediately so a new create can reuse it
  for (const [id, peer] of peers) {
    if (id === exceptId) continue;
    sendJSON(peer, { type: 'room-closed', reason });
    peer.close(4010, reason);
  }
}
// Health endpoint for LB/uptime checks; WS upgrades are handled separately by the WSS.
const server = createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  } else {
    res.writeHead(426, { 'content-type': 'text/plain' });
    res.end('upgrade required');
  }
});
const wss = new WebSocketServer({ server, maxPayload: MAX_PAYLOAD });
wss.on('connection', (ws, req) => {
  ws.on('error', () => {}); // FIRST: a socket 'error' with no listener crashes the whole process
  const url        = new URL(req.url, 'http://localhost');
  const app        = url.searchParams.get('app') || '';
  const wantCreate = url.searchParams.get('create') === '1';
  const roomParam  = url.searchParams.get('room') || '';
  const codeType   = url.searchParams.get('codeType') || ''; // '' = default 4-digit; 'word' = EFF short #2
  const origin     = req.headers.origin;
  const ip         = clientIp(req);
  const cfg = APPS[app];
  if (!cfg)                                          return ws.close(4000, 'unknown app');
  // Origin is hygiene, not authn (a non-browser client can omit it). Browsers always send it.
  if (!origin || !cfg.origins.includes(origin))      return ws.close(4003, 'origin not allowed');
  // Global resource caps (checked before we create/join anything).
  if (wss.clients.size > MAX_CONNS_TOTAL)             return ws.close(4005, 'server busy');
  if ((ipCounts.get(ip) || 0) >= MAX_CONNS_PER_IP)   return ws.close(4006, 'too many connections');
  // Resolve the code shape for this codeType (4-digit by default; a word for ?codeType=word).
  const spec = codeSpec(cfg, codeType);
  // Resolve the room: CREATE (server allocates) vs JOIN (must already exist, unless app opts in).
  let code, key, peers;
  if (wantCreate) {
    if (rooms.size >= MAX_ROOMS)                      return ws.close(4005, 'server busy');
    code = allocateCode(app, spec.allocate);
    if (code == null)                                 return ws.close(4005, 'no free rooms');
    key = `${app}:${code}`;
    peers = new Map();
    rooms.set(key, peers);
  } else {
    if (!spec.valid(roomParam))                       return ws.close(4001, 'bad room');
    code = roomParam;
    key = `${app}:${code}`;
    peers = rooms.get(key);
    if (!peers) {
      if (!cfg.joinMayCreate)                         return ws.close(4009, 'room not found');
      if (rooms.size >= MAX_ROOMS)                    return ws.close(4005, 'server busy');
      peers = new Map();
      rooms.set(key, peers);
    }
  }
  // Word rooms are strictly 1:1 (creator + one joiner) so guessing is serialized; other
  // codeTypes keep the app's lobby size. An extra joiner is bounced with a clear "room full".
  const maxPeers = codeType === 'word' ? WORD_ROOM_MAX_PEERS : cfg.maxPeers;
  if (peers.size >= maxPeers)                         return ws.close(4002, 'room full');
  // Per-IP-per-room cap: stops a single IP from filling a lobby on its own (anti-squat).
  let sameIp = 0;
  for (const p of peers.values()) if (p._ip === ip) sameIp++;
  if (sameIp >= MAX_PER_IP_PER_ROOM)                 return ws.close(4007, 'too many from your network');
  // Accepted — register.
  const selfId = makeReadableId(peers);
  ws._id = selfId; ws._ip = ip; ws._roomKey = key; ws.isAlive = true;
  ws._msgWindowStart = Date.now(); ws._msgCount = 0;
  ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
  ws.on('pong', () => { ws.isAlive = true; });
  // newcomer learns its id, the room code (esp. needed for create), and who is already here
  sendJSON(ws, { type: 'welcome', selfId, room: code, peers: [...peers.keys()] });
  // everyone else learns a peer arrived
  for (const peer of peers.values()) sendJSON(peer, { type: 'peer-joined', peerId: selfId });
  peers.set(selfId, ws);
  // Word-room lifecycle: on CREATE pin the creator (only it may destroy the room) and arm the
  // TTL so a leaked rendezvous word can't be guessed against forever. unref() so a pending
  // timer never keeps the process alive.
  if (codeType === 'word' && wantCreate) {
    const timer = setTimeout(() => closeWordRoom(key, 'expired'), WORD_ROOM_TTL_MS);
    if (timer.unref) timer.unref();
    roomMeta.set(key, { creatorId: selfId, timer });
  }
  ws.on('message', (data) => {
    // fixed-window message rate limit (bounds relay-flood and parse-CPU abuse)
    const now = Date.now();
    if (now - ws._msgWindowStart > MSG_WINDOW_MS) { ws._msgWindowStart = now; ws._msgCount = 0; }
    if (++ws._msgCount > MSG_HARD_LIMIT) return ws.close(4008, 'rate limit');
    if (ws._msgCount > MSG_SOFT_LIMIT) return;              // drop, don't relay
    let msg;
    try { msg = JSON.parse(data); } catch { return; }       // binary / garbage -> ignored
    // Creator-only word-room teardown: free the word + evict the joiner. Honored ONLY from the
    // socket that created the room (a joiner can't tear down someone else's rendezvous). The
    // creator's own socket is left open (exceptId) — it manages its own next step client-side.
    if (msg.type === 'destroy') {
      const meta = roomMeta.get(ws._roomKey);
      if (meta && meta.creatorId === selfId) closeWordRoom(ws._roomKey, 'destroyed', selfId);
      return;
    }
    if (msg.type !== 'signal' || !msg.to || msg.to === selfId) return;
    const target = peers.get(msg.to);                        // only peers in THIS room are addressable
    if (!target || target.readyState !== target.OPEN) return;
    sendJSON(target, { type: 'signal', from: selfId, data: msg.data }); // server sets `from` (no spoofing)
  });
  ws.on('close', () => {
    const n = (ipCounts.get(ip) || 1) - 1;
    if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
    peers.delete(selfId);
    for (const peer of peers.values()) sendJSON(peer, { type: 'peer-left', peerId: selfId });
    // identity-guarded delete: stays correct even if a future async close handler interleaves
    if (rooms.get(key) === peers && peers.size === 0) {
      rooms.delete(key);
      // Cancel a word room's TTL when it empties on its own, so the timer can't later fire on a
      // DIFFERENT room that reused the same freed word.
      const meta = roomMeta.get(key);
      if (meta && meta.timer) clearTimeout(meta.timer);
      roomMeta.delete(key);
    }
  });
});
// Heartbeat: drop ghosts that never fired 'close' (frees their room + IP slot).
// terminate() emits 'close', so the cleanup handler above still runs.
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_MS);
wss.on('close', () => clearInterval(interval));
function sendJSON(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
// Graceful shutdown: stop accepting, close open sockets, then exit.
function shutdown() {
  clearInterval(interval);
  for (const ws of wss.clients) ws.close(1001, 'server shutting down');
  wss.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref(); // force-exit if sockets linger
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
server.listen(PORT, HOST, () => console.log(`Mesh signaling server listening on ${HOST}:${PORT}`));
