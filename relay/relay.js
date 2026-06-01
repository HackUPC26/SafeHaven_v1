// SafeHaven v1 — stateful WebSocket relay (M1)
// ---------------------------------------------------------------------------
// Single source of truth: ../PROTOCOL.md. Where this file and the spec ever
// disagree, the spec wins. Section references (§N) point at PROTOCOL.md.
//
// What this relay is (and is NOT):
//   - It is a STATEFUL, per-token room manager (§7). Per session token it keeps,
//     in RAM only:
//       * the live sender socket (one per token, §1.3 / §6.3),
//       * the set of receiver sockets (many per token),
//       * the full ordered eventLog of every product-event TEXT frame since the
//         current incident opened, and
//       * the last BINARY frame whose header KEYFRAME flag is set (lastVideoIDR).
//   - On a receiver join it replays the ENTIRE eventLog in order, THEN the
//     lastVideoIDR, BEFORE any live frame reaches that receiver (§7 / §8), so a
//     contact opening the link mid-incident sees the whole timeline from the
//     start, never history interleaved with live.
//   - It is NOT a decoder, NOT a parser of payloads, NOT a disk store, and NOT a
//     peer-to-peer signaler. There is no SDP/ICE/offer/answer machinery; the
//     legacy no-role "bridge" branch that console.log'd message bodies is gone.
//
// Privacy invariants (§7 / §9):
//   - RAM only; nothing is ever written to disk.
//   - It NEVER logs frame payloads — only connection metadata, token-prefixed.
//   - It reads ONLY: the WS frame TYPE (text vs binary), the top-level envelope
//     `type` of TEXT frames (to know a frame is a product "event" worth logging
//     — it does NOT parse the inner payload / event_type), and the binary
//     header's KEYFRAME flag (to know which media frame to retain). This is
//     exactly why the deferred encryption seam (§9) can encrypt payloads later
//     without the relay changing at all: the relay never reads what it forwards.
//
// Structure/idioms here intentionally echo the legacy signaling.js
// (createServer + WebSocketServer({server}), a `rooms` Map keyed by token, a
// short token tag for logs), but ALL of its WebRTC routing was discarded.

import { WebSocketServer } from 'ws'
import { createServer } from 'http'
import { readFile, stat } from 'fs/promises'
import { join, dirname, normalize, extname } from 'path'
import { fileURLToPath } from 'url'
import { networkInterfaces } from 'os'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Configuration (§11) ----------------------------------------------------
const PORT = Number(process.env.PORT) || 8080
// High safety cap on the per-session event log (§7). On overflow we drop the
// OLDEST events and log a truncation line — never a silent discard.
const MAX_EVENT_LOG = Number(process.env.MAX_EVENT_LOG) || 10000
// ws-level ping/pong heartbeat. A socket that misses two consecutive pings
// (i.e. ~2× this interval with no pong) is presumed dead and terminated. This
// is what lets a legitimate sender reconnect after a hard network drop without
// being wrongly rejected as 4002 "sender already connected" — see reclaimStaleSender.
const HEARTBEAT_INTERVAL_MS = 30000

// Protocol version we speak (§10). v mismatch policy below is "warn-and-allow"
// by default (documented), with the 4003 close code reserved and ready.
const PROTOCOL_VERSION = '1'
// Set to true to hard-reject a version mismatch with close 4003 instead of
// warning and allowing. Default false === tolerate-and-warn (§10 default).
const STRICT_VERSION = process.env.STRICT_VERSION === '1'

// Where the built receiver SPA lives in production (§ static hosting).
// In dev you run the Vite dev server separately; this dir simply won't exist
// and the relay serves 404 + a one-time hint (see makeHttpHandler).
const RECEIVER_DIST = join(__dirname, '..', 'receiver', 'dist')

// --- Close codes (§10) ------------------------------------------------------
const CLOSE = Object.freeze({
  INVALID_ROLE: 4000,       // role not in {sender, receiver}
  MISSING_TOKEN: 4001,      // token absent / empty
  SENDER_TAKEN: 4002,       // a live sender already holds this token
  VERSION_MISMATCH: 4003,   // v != PROTOCOL_VERSION (only used when STRICT_VERSION)
})

// ---------------------------------------------------------------------------
// Room state (§7). rooms: Map<token, RoomState>.
//
//   RoomState {
//     sender:       WebSocket | null
//     receivers:    Map<connId, WebSocket>
//     eventLog:     string[]                 // every product-event TEXT frame since incident_start, in order
//     lastVideoIDR: Buffer | ArrayBuffer | null   // last BINARY frame with KEYFRAME flag set (header + payload, verbatim)
//   }
//
// All of this is in-memory and is dropped when the room is torn down
// (!sender && receivers.size === 0). Nothing here ever touches disk.
// ---------------------------------------------------------------------------
const rooms = new Map()

function getOrCreateRoom(token) {
  let room = rooms.get(token)
  if (!room) {
    room = { sender: null, receivers: new Map(), eventLog: [], lastVideoIDR: null }
    rooms.set(token, room)
  }
  return room
}

// Tear a room down once nobody is in it. Dropping the room drops its entire
// eventLog + lastVideoIDR — the spec's "drop the entire log when the room is
// torn down" (§7).
function maybeDropRoom(token, room) {
  if (!room.sender && room.receivers.size === 0) {
    rooms.delete(token)
    return true
  }
  return false
}

// Short, non-sensitive token tag for log lines (connection metadata only — we
// never log the full token's companion `key`, which the relay never even sees).
function tag(token) {
  return token.slice(0, 8)
}

// Monotonic connection id generator for receivers (the relay's internal handle;
// it is NOT a wire concept — there is no per-receiver addressing, §6.3).
let connSeq = 0
function nextConnId() {
  return `r${(++connSeq).toString(36)}`
}

// --- Frame classification (header / envelope `type` ONLY, never payload) -----
//
// Returns the top-level envelope `type` of a TEXT frame, or null if the frame
// is not parseable JSON / has no string `type`. We deliberately read ONLY the
// top-level `type` so we can recognise a product "event" worth logging (§6.1 /
// §7). We do NOT touch `payload` or `event_type` — that's the encryption seam's
// territory (§9) and the relay must stay payload-opaque.
function envelopeType(textFrame) {
  // Cheap guard: a product/control envelope is a JSON object starting with '{'.
  // This avoids JSON.parse on, say, a stray non-JSON string.
  if (textFrame.length === 0 || textFrame.charCodeAt(0) !== 0x7b /* '{' */) return null
  try {
    const obj = JSON.parse(textFrame)
    return obj && typeof obj.type === 'string' ? obj.type : null
  } catch {
    return null
  }
}

// Does a TEXT frame carry a fresh incident_start? (§7 session boundary.)
// We must detect this to clear the eventLog at the start of a new incident —
// and it's the ONE case where we have to peek past the envelope at the inner
// event_type. We keep that peek as narrow as possible: only when type==="event",
// only reading the single field `payload.event_type`, never anything else, and
// never logging it. This is the minimal read the stateful-replay design (§7)
// requires; documented as such so the encryption seam (§9) can later mark
// incident_start as a relay-visible control field if/when payloads encrypt.
function isIncidentStart(textFrame) {
  try {
    const obj = JSON.parse(textFrame)
    return obj?.type === 'event' && obj?.payload?.event_type === 'incident_start'
  } catch {
    return false
  }
}

// Binary header parse — KEYFRAME flag ONLY (§3). 16-byte little-endian header:
//   byte0 version, byte1 kind, byte2 flags(bit0=KEYFRAME), byte3 cacheClass, ...
// We read byte2 bit0 and nothing else. The payload (bytes 16..) is opaque.
function binaryHasKeyframe(buf) {
  // `buf` may be a Node Buffer (most common from ws) or an ArrayBuffer.
  if (buf.byteLength < 16) return false
  const flags = buf instanceof ArrayBuffer ? new Uint8Array(buf)[2] : buf[2]
  return (flags & 0x01) === 0x01 // bit0 = KEYFRAME / IDR
}

// --- Per-receiver replay gating (§8 ordering & replay atomicity) -------------
//
// When a receiver joins we must deliver: full eventLog (in order) -> lastVideoIDR
// -> then live frames. Live frames that arrive DURING that replay must be
// buffered for THAT receiver and flushed only after replay completes, so
// history never interleaves with live. We stash a small per-socket state on the
// ws object (`ws._sh`) rather than a side Map, mirroring how ws lets you tack
// connection state onto the socket.
function sendToReceiver(ws, frame, isBinary) {
  const sh = ws._sh
  if (sh && !sh.replayDone) {
    // Replay still in flight for this receiver — queue the live frame in order.
    sh.liveQueue.push({ frame, isBinary })
    return
  }
  rawSend(ws, frame, isBinary)
}

// Low-level guarded send. `isBinary` selects the WS frame type explicitly so a
// Buffer is never accidentally sent as text (ws would otherwise infer it).
function rawSend(ws, frame, isBinary) {
  if (ws.readyState !== ws.OPEN) return
  ws.send(frame, { binary: !!isBinary })
}

// Atomically replay the room's history to a freshly joined receiver, then open
// its live gate and flush anything that queued up during the replay (§7 / §8).
function replayHistoryThenGoLive(ws, room, token) {
  const sh = ws._sh
  // 1) Full eventLog, in arrival order — verbatim TEXT frames.
  for (const textFrame of room.eventLog) {
    rawSend(ws, textFrame, false)
  }
  // 2) Last video IDR (if any) — verbatim BINARY frame, so the receiver can
  //    start decoding within one IDR cadence without waiting for a fresh one.
  if (room.lastVideoIDR) {
    rawSend(ws, room.lastVideoIDR, true)
  }
  // 3) Open the live gate and flush any frames that arrived mid-replay, in order.
  sh.replayDone = true
  const queued = sh.liveQueue
  sh.liveQueue = []
  for (const { frame, isBinary } of queued) {
    rawSend(ws, frame, isBinary)
  }
  console.log(
    `[${tag(token)}] receiver ${sh.connId} replay flushed ` +
    `(events=${room.eventLog.length}, idr=${room.lastVideoIDR ? 'yes' : 'no'}, ` +
    `liveBuffered=${queued.length})`
  )
}

// --- Presence (§6.2) — relay -> sender only ---------------------------------
function notifySenderPresence(room, event) {
  if (!room.sender || room.sender.readyState !== room.sender.OPEN) return
  room.sender.send(JSON.stringify({
    type: 'presence',
    event,                         // "receiver_joined" | "receiver_left"
    receivers: room.receivers.size,
  }))
}

// --- Stale-sender reclamation (heartbeat) -----------------------------------
//
// Problem: if a sender's network drops hard (no clean WS close), its socket can
// linger in CONNECTING/OPEN-but-dead state. A legitimate sender reconnect would
// then be wrongly rejected as 4002. Solution: a ws-level ping every
// HEARTBEAT_INTERVAL_MS. Each socket sets isAlive=false on ping and back to true
// on pong; a socket that fails to pong within one interval is terminated, which
// frees room.sender so the real reconnect is accepted. This is the documented
// "reclaim a stale sender" behaviour.
function reclaimStaleSenderIfDead(room, token) {
  const s = room.sender
  if (!s) return
  if (s.readyState !== s.OPEN || s._sh?.isAlive === false) {
    // Treat as dead; drop our reference so a new sender can take the token.
    console.log(`[${tag(token)}] reclaiming stale/dead sender before accepting new one`)
    try { s.terminate() } catch { /* already gone */ }
    if (room.sender === s) room.sender = null
  }
}

// ===========================================================================
// HTTP server: in production, serve the built receiver SPA from RECEIVER_DIST
// on the same single port the WebSocket lives on. In dev, RECEIVER_DIST is
// absent and we serve 404 (Vite dev server handles the UI instead).
// ===========================================================================
let warnedMissingDist = false

function contentType(file) {
  switch (extname(file).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8'
    case '.js':   return 'application/javascript; charset=utf-8'
    case '.mjs':  return 'application/javascript; charset=utf-8'
    case '.css':  return 'text/css; charset=utf-8'
    case '.json': return 'application/json; charset=utf-8'
    case '.svg':  return 'image/svg+xml'
    case '.png':  return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.ico':  return 'image/x-icon'
    case '.webmanifest': return 'application/manifest+json'
    case '.map':  return 'application/json; charset=utf-8'
    default:      return 'application/octet-stream'
  }
}

async function tryServeFile(res, absPath, asHtmlFallback = false) {
  try {
    const body = await readFile(absPath)
    res.writeHead(200, { 'Content-Type': contentType(absPath) })
    res.end(body)
    return true
  } catch {
    if (asHtmlFallback) return false
    return false
  }
}

function makeHttpHandler() {
  return async (req, res) => {
    // Only GET/HEAD are meaningful for static hosting.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405); res.end(); return
    }

    const { pathname } = new URL(req.url, 'http://x')

    // Confirm the dist exists; if not, this deployment is dev-mode (Vite dev
    // server serves the UI). Serve nothing and log a one-time hint (§ static).
    let distExists = false
    try {
      const st = await stat(RECEIVER_DIST)
      distExists = st.isDirectory()
    } catch {
      distExists = false
    }

    if (!distExists) {
      if (!warnedMissingDist) {
        warnedMissingDist = true
        console.log(
          `[http] receiver/dist not found at ${RECEIVER_DIST} — serving 404 for ` +
          `static assets. This is expected in DEV: run the Vite dev server for ` +
          `the receiver UI and point it at this relay's /ws. In PRODUCTION, build ` +
          `the receiver (vite build) so dist/ exists and is served on this port.`
        )
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Not found (receiver/dist absent — dev mode: use the Vite dev server)\n')
      return
    }

    // Resolve the request path within dist, guarding against path traversal:
    // normalize and ensure the resolved path stays under RECEIVER_DIST.
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const candidate = normalize(join(RECEIVER_DIST, rel))
    if (!candidate.startsWith(RECEIVER_DIST)) {
      res.writeHead(403); res.end(); return
    }

    if (await tryServeFile(res, candidate)) return

    // SPA fallback: unknown non-asset routes serve index.html so the client
    // router (and the #<token>:<key> fragment) works on deep links.
    const indexPath = join(RECEIVER_DIST, 'index.html')
    if (await tryServeFile(res, indexPath)) return

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('Not found\n')
  }
}

// ===========================================================================
// WebSocket server.
// ===========================================================================
const server = createServer(makeHttpHandler())
const wss = new WebSocketServer({ server })

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname
  const role = url.searchParams.get('role')
  const token = url.searchParams.get('token')
  const v = url.searchParams.get('v')

  // Only the /ws endpoint speaks the protocol. Anything else is a stray client.
  if (path !== '/ws') {
    ws.close(CLOSE.INVALID_ROLE, 'unknown endpoint')
    return
  }

  // --- Validation order matches the contract's close-code semantics (§1.3 / §10).
  // role must be sender|receiver, else 4000.
  if (role !== 'sender' && role !== 'receiver') {
    ws.close(CLOSE.INVALID_ROLE, 'invalid role')
    return
  }
  // token required, else 4001. (The companion `key` never reaches the relay.)
  if (!token) {
    ws.close(CLOSE.MISSING_TOKEN, 'missing token')
    return
  }
  // version: default is tolerate-and-warn (§10). With STRICT_VERSION, mismatch
  // closes 4003. We accept a missing v too (legacy/optional) but warn.
  if (v !== PROTOCOL_VERSION) {
    if (STRICT_VERSION) {
      ws.close(CLOSE.VERSION_MISMATCH, 'version mismatch')
      return
    }
    console.warn(`[${tag(token)}] ${role} connected with v=${v ?? '(none)'} (expected ${PROTOCOL_VERSION}) — tolerating`)
  }

  // Heartbeat liveness state lives on the socket (§ stale-sender reclaim).
  ws._sh = ws._sh || {}
  ws._sh.isAlive = true
  ws.on('pong', () => { ws._sh.isAlive = true })

  if (role === 'sender') {
    handleSender(ws, token)
  } else {
    handleReceiver(ws, token)
  }
})

// --- Sender connection ------------------------------------------------------
function handleSender(ws, token) {
  const room = getOrCreateRoom(token)

  // One sender per token (§1.3 / §6.3). Before rejecting a new sender, reclaim
  // a stale/dead one so a legit reconnect after a hard drop isn't blocked.
  reclaimStaleSenderIfDead(room, token)
  if (room.sender && room.sender.readyState === room.sender.OPEN) {
    console.log(`[${tag(token)}] rejecting duplicate sender (one already live)`)
    ws.close(CLOSE.SENDER_TAKEN, 'sender already connected')
    // If the new (rejected) socket created the room moment ago, don't leak it.
    maybeDropRoom(token, room)
    return
  }

  room.sender = ws
  Object.assign(ws._sh, { role: 'sender', token })
  console.log(`[${tag(token)}] sender connected (receivers: ${room.receivers.size})`)

  // If receivers are already present (sender reconnected mid-incident), tell the
  // sender so it can ensure it's encoding for the current tier and force an IDR
  // for fast resync (§6.2). The cached state already covers the timeline.
  if (room.receivers.size > 0) {
    notifySenderPresence(room, 'receiver_joined')
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // BINARY = media (§3). Forward verbatim to all receivers; retain the last
      // IDR. We read ONLY the KEYFRAME flag — never the payload.
      // ws delivers binary as a Buffer (or array of Buffers if fragmented).
      const frame = Array.isArray(data) ? Buffer.concat(data) : data
      if (binaryHasKeyframe(frame)) {
        room.lastVideoIDR = frame // retain-last-of-kind for video IDR (§3 cacheClass=1)
      }
      for (const recv of room.receivers.values()) {
        sendToReceiver(recv, frame, true)
      }
      return
    }

    // TEXT = control + product events (§2 / §5). We look only at the top-level
    // envelope `type`.
    const text = data.toString()
    const type = envelopeType(text)

    if (type === 'event') {
      // A fresh incident_start opens a NEW session: clear the prior eventLog and
      // the stale IDR so a late joiner doesn't see a previous incident's history
      // (§7 session boundary). This is the one narrow inner peek we allow.
      if (isIncidentStart(text)) {
        if (room.eventLog.length > 0 || room.lastVideoIDR) {
          console.log(`[${tag(token)}] incident_start — clearing prior session log (${room.eventLog.length} events)`)
        }
        room.eventLog = []
        room.lastVideoIDR = null
      }

      // Append the verbatim TEXT frame to the per-session log (§7).
      room.eventLog.push(text)
      // Memory bound (§7 / §11): drop oldest on overflow, log a truncation line.
      if (room.eventLog.length > MAX_EVENT_LOG) {
        const dropped = room.eventLog.length - MAX_EVENT_LOG
        room.eventLog.splice(0, dropped)
        console.log(`[${tag(token)}] eventLog cap ${MAX_EVENT_LOG} exceeded — dropped ${dropped} oldest event(s) (NOT silent)`)
      }

      // Fan out verbatim to all receivers (§6.3).
      for (const recv of room.receivers.values()) {
        sendToReceiver(recv, text, false)
      }
      return
    }

    if (type === 'hello') {
      // Optional announce on (re)connect (§6.1). Role/token already came via the
      // query string; nothing to route. We simply accept it (reserved for future
      // negotiation). Not logged with payload — metadata only.
      return
    }

    // Unknown/other top-level types from a sender are ignored (forward nothing).
    // We do NOT forward arbitrary non-event text, keeping the wire tight.
  })

  ws.on('close', (code, reason) => {
    console.log(`[${tag(token)}] sender disconnected code=${code} reason=${reason?.toString() || ''}`)
    if (room.sender === ws) room.sender = null
    // Sender leaving does NOT clear the eventLog: a late receiver should still
    // see the timeline (incl. incident_closed if it was sent). Room is only torn
    // down when truly empty (§7).
    maybeDropRoom(token, room)
  })

  ws.on('error', (err) => {
    console.warn(`[${tag(token)}] sender socket error: ${err?.message || err}`)
  })
}

// --- Receiver connection ----------------------------------------------------
function handleReceiver(ws, token) {
  const room = getOrCreateRoom(token)
  const connId = nextConnId()

  // Per-receiver replay gate (§8). Live frames queue here until history is flushed.
  Object.assign(ws._sh, {
    role: 'receiver',
    token,
    connId,
    replayDone: false,
    liveQueue: [],
  })
  room.receivers.set(connId, ws)
  console.log(`[${tag(token)}] receiver ${connId} connected (sender present: ${room.sender?.readyState === room.sender?.OPEN}, receivers: ${room.receivers.size})`)

  // Tell the sender a receiver joined (with the new count) so it can ensure it's
  // encoding for the current tier and force an IDR for fast resync (§6.2).
  notifySenderPresence(room, 'receiver_joined')

  // Atomically replay the full timeline + last IDR BEFORE any live frame for
  // this receiver (§7 / §8). Frames arriving during replay are buffered above
  // and flushed in order at the end.
  replayHistoryThenGoLive(ws, room, token)

  ws.on('message', (data, isBinary) => {
    // Receivers may ONLY send `hello` to the relay; they NEVER reach the sender
    // or other receivers (§6.1 / §6.3). Anything else is dropped.
    if (isBinary) return
    const type = envelopeType(data.toString())
    if (type === 'hello') {
      // Accept (reserved for future negotiation). No forwarding, no payload log.
      return
    }
    // Silently ignore any other receiver-origin text — receivers are read-only
    // on the product stream.
  })

  ws.on('close', (code, reason) => {
    console.log(`[${tag(token)}] receiver ${connId} disconnected code=${code} reason=${reason?.toString() || ''}`)
    if (room.receivers.get(connId) === ws) room.receivers.delete(connId)
    // Presence: tell the sender a receiver left (with updated count) (§6.2).
    notifySenderPresence(room, 'receiver_left')
    maybeDropRoom(token, room)
  })

  ws.on('error', (err) => {
    console.warn(`[${tag(token)}] receiver ${connId} socket error: ${err?.message || err}`)
  })
}

// --- Heartbeat sweep (stale-socket detection) -------------------------------
// Every interval: terminate any socket that didn't pong since the last sweep,
// then ping the rest. Terminating a dead sender frees the token for a legit
// reconnect (documented above in reclaimStaleSenderIfDead).
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    const sh = ws._sh
    if (sh && sh.isAlive === false) {
      // Missed the previous ping → presume dead.
      try { ws.terminate() } catch { /* ignore */ }
      continue
    }
    if (sh) sh.isAlive = false
    try { ws.ping() } catch { /* ignore */ }
  }
}, HEARTBEAT_INTERVAL_MS)
heartbeat.unref?.() // don't keep the process alive solely for the heartbeat

wss.on('close', () => clearInterval(heartbeat))

// --- Boot -------------------------------------------------------------------
function getLocalIP() {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address
    }
  }
  return 'localhost'
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP()
  console.log()
  console.log('╔════════════════════════════════════════════════════╗')
  console.log(`║  SafeHaven v1 Relay (M1)        port ${String(PORT).padEnd(15)}║`)
  console.log('╠════════════════════════════════════════════════════╣')
  console.log(`║  WebSocket:  ws://${ip}:${PORT}/ws`.padEnd(54) + '║')
  console.log(`║  Receiver:   http://${ip}:${PORT}/  (if dist built)`.padEnd(54) + '║')
  console.log('╠════════════════════════════════════════════════════╣')
  console.log(`║  Roles: ?role=sender|receiver&token=<hex>&v=1`.padEnd(54) + '║')
  console.log(`║  Event-log cap: ${String(MAX_EVENT_LOG).padEnd(36)}║`)
  console.log(`║  Version policy: ${(STRICT_VERSION ? 'strict (close 4003)' : 'warn-and-allow').padEnd(35)}║`)
  console.log('╚════════════════════════════════════════════════════╝')
  console.log()
  console.log('Waiting for connections...')
})

// Graceful shutdown: close sockets so clients get a clean close + reconnect.
function shutdown(sig) {
  console.log(`\n[relay] ${sig} — shutting down`)
  clearInterval(heartbeat)
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down') } catch { /* ignore */ }
  }
  server.close(() => process.exit(0))
  // Hard exit if sockets don't drain quickly.
  setTimeout(() => process.exit(0), 2000).unref?.()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
