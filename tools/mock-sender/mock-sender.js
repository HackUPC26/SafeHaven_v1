// SafeHaven v1 — mock sender (test tool)
// ---------------------------------------------------------------------------
// Connects to the relay as role=sender and drives a SCRIPTED incident from
// start to finish, so the receiver dashboard can be exercised end-to-end before
// the native Swift sender exists. A human runs the relay, runs this, opens the
// printed receiver URL, and watches a full incident populate (header + name,
// tier escalations, a moving GPS trail around Barcelona, cycling AI labels, live
// PCM audio, and headed video frames).
//
// Authoritative spec: ../../PROTOCOL.md. Section refs (§N) point at it. The wire
// shapes below mirror the legacy ../../../SafeHaven/p2p-hello/sender-demo.html
// (token generation, receiver URL, event envelope) but produce the v1 framed
// wire (one WebSocket of TEXT events + BINARY media), NOT WebRTC.
//
// Usage:
//   node mock-sender.js [--host=localhost:8080] [--pace=1] [--no-video]
//                       [--name=Maria] [--duration=auto] [--max-tier=3]
//
// Flags:
//   --host=HOST:PORT   relay host:port (default localhost:8080). Accepts a bare
//                      host (ws assumed) or a full ws(s):// URL.
//   --pace=N           time multiplier for the whole script. N>1 = slower (more
//                      time to watch), N<1 = faster. Default 1.
//   --video / --no-video   include/exclude BINARY video frames. Default: include.
//   --name=NAME        person_name in incident_start. Default "Maria".
//   --max-tier=T       highest tier the script escalates to (1..3). Default 3.
//   --close            after escalating, de-escalate and emit incident_closed,
//                      then exit. Default: stays live streaming until Ctrl-C.
//
// IMPORTANT — VIDEO (documented limitation):
//   This tool emits BINARY video frames with a CORRECT 16-byte little-endian
//   header (§3) — version, kind=VIDEO_H264, KEYFRAME flag set every 2 s,
//   cacheClass=retain-last-of-kind on keyframes, monotonic per-kind seq,
//   ptsMicros — and a payload that is *Annex-B-shaped* (00 00 00 01 start codes
//   wrapping placeholder NAL bytes) but is NOT a genuinely decodable H.264
//   bitstream. Hand-rolling a valid H.264 encoder in pure Node is out of scope.
//   This fully exercises the receiver's FRAMING path (frame-type routing, header
//   parse, keyframe gating/await-keyframe, seq loss/restart detection, relay IDR
//   caching + replay) and the "FEED FROZEN"/decode-error fallback (§4.3), but the
//   receiver's WebCodecs DECODE will reject these frames. To verify the actual
//   decode path, drive the receiver with the real Swift sender (VideoToolbox →
//   Annex-B), or extend this tool to read a pre-encoded Annex-B .h264 file.
//   Audio, by contrast, is REAL: a synthesized sine-wave PCM Int16 stream the
//   receiver can actually play. Pass --no-video to test the WebCodecs-absent /
//   audio-only path cleanly.

import { WebSocket } from 'ws'
import { randomBytes } from 'crypto'

// ---------------------------------------------------------------------------
// Binary framing (§3) — must match the relay/receiver byte-for-byte.
// 16-byte LITTLE-ENDIAN header:
//   0  u8  version    = 0x01
//   1  u8  kind       1 = VIDEO_H264, 2 = AUDIO_PCM
//   2  u8  flags      bit0 = KEYFRAME (video IDR); audio = 0
//   3  u8  cacheClass 0 = none, 1 = retain-last-of-kind
//   4  u32 seq        per-kind monotonic, resets on sender reconnect
//   8  u64 ptsMicros  capture-clock microseconds
//   16 ... payload    opaque (encoded video AU or PCM chunk)
// ---------------------------------------------------------------------------
const VERSION = 0x01
const KIND_VIDEO_H264 = 1
const KIND_AUDIO_PCM = 2
const FLAG_KEYFRAME = 0x01
const CACHE_NONE = 0
const CACHE_RETAIN_LAST = 1
const HEADER_BYTES = 16

function buildFrame({ kind, flags = 0, cacheClass = CACHE_NONE, seq, ptsMicros, payload }) {
  const out = Buffer.allocUnsafe(HEADER_BYTES + payload.length)
  out.writeUInt8(VERSION, 0)
  out.writeUInt8(kind, 1)
  out.writeUInt8(flags, 2)
  out.writeUInt8(cacheClass, 3)
  out.writeUInt32LE(seq >>> 0, 4)
  // u64 ptsMicros — write as BigInt LE to keep full microsecond precision.
  out.writeBigUInt64LE(BigInt(Math.max(0, Math.floor(ptsMicros))), 8)
  payload.copy(out, HEADER_BYTES)
  return out
}

// ---------------------------------------------------------------------------
// Audio (§4.2) — REAL synthetic PCM the receiver can play.
// Int16 LE, mono, 16 kHz, 20 ms chunks (320 samples = 640 bytes).
// ---------------------------------------------------------------------------
const SAMPLE_RATE = 16000
const CHUNK_MS = 20
const SAMPLES_PER_CHUNK = (SAMPLE_RATE * CHUNK_MS) / 1000 // 320
const AUDIO_BYTES_PER_CHUNK = SAMPLES_PER_CHUNK * 2       // 640

// Continuous-phase sine generator so chunks join seamlessly (no clicks).
function makeSineSource(freqHz = 440, amplitude = 0.25) {
  let phase = 0
  const step = (2 * Math.PI * freqHz) / SAMPLE_RATE
  return function nextChunk() {
    const buf = Buffer.allocUnsafe(AUDIO_BYTES_PER_CHUNK)
    for (let i = 0; i < SAMPLES_PER_CHUNK; i++) {
      const s = Math.sin(phase) * amplitude
      phase += step
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI
      // clamp to Int16 range then write LE
      const v = Math.max(-32768, Math.min(32767, Math.round(s * 32767)))
      buf.writeInt16LE(v, i * 2)
    }
    return buf
  }
}

// ---------------------------------------------------------------------------
// Video (§3 / §4.1) — placeholder Annex-B-SHAPED payload (see header note).
// Real H.264 frame layout we mimic: each access unit is Annex-B with 4-byte
// start codes; IDR carries SPS+PPS in-band. We emit start-code-prefixed
// placeholder NAL bytes so the framing/keyframe path is fully exercised, while
// being honest that this is not decodable.
// ---------------------------------------------------------------------------
const ANNEXB_START = Buffer.from([0x00, 0x00, 0x00, 0x01])

function makePlaceholderVideoPayload(isKeyframe) {
  // For an IDR we prepend two short "SPS"/"PPS"-shaped NALs then the "IDR" NAL,
  // mirroring the real in-band-parameter-set layout (§4.1). For deltas, just one
  // "non-IDR slice" NAL. The bytes after the NAL header type are placeholder.
  // NAL header byte (Annex-B): forbidden_zero(1)|nal_ref_idc(2)|nal_unit_type(5)
  const filler = randomBytes(48) // arbitrary placeholder body
  if (isKeyframe) {
    const sps = Buffer.concat([ANNEXB_START, Buffer.from([0x67]), randomBytes(8)]) // type 7 = SPS
    const pps = Buffer.concat([ANNEXB_START, Buffer.from([0x68]), randomBytes(4)]) // type 8 = PPS
    const idr = Buffer.concat([ANNEXB_START, Buffer.from([0x65]), filler])         // type 5 = IDR slice
    return Buffer.concat([sps, pps, idr])
  }
  const slice = Buffer.concat([ANNEXB_START, Buffer.from([0x41]), filler])         // type 1 = non-IDR slice
  return Buffer.concat([slice])
}

// ---------------------------------------------------------------------------
// Pairing + URL (§1.1 / §1.2). token and key are each 32 hex chars (16 bytes),
// crypto-random. Receiver URL fragment = #<token>:<key>. The key is never sent
// to the relay; it lives only in the fragment (encryption seam, §9 — unused).
// ---------------------------------------------------------------------------
function hex16() {
  return randomBytes(16).toString('hex') // 32 hex chars
}

// ---------------------------------------------------------------------------
// Product-event envelope (§5). Every product event carries timestamp_iso:
// ISO-8601 UTC, millisecond precision, trailing Z. JS Date#toISOString already
// emits exactly e.g. "2026-06-01T12:34:56.789Z".
// ---------------------------------------------------------------------------
function nowIso() {
  return new Date().toISOString()
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    host: 'localhost:8080',
    pace: 1,
    video: true,
    name: 'Maria',
    maxTier: 3,
    close: false,
  }
  for (const a of argv.slice(2)) {
    if (a === '--no-video') { args.video = false; continue }
    if (a === '--video') { args.video = true; continue }
    if (a === '--close') { args.close = true; continue }
    const m = a.match(/^--([^=]+)=(.*)$/)
    if (!m) { console.warn(`[mock-sender] ignoring unknown arg: ${a}`); continue }
    const [, k, val] = m
    switch (k) {
      case 'host': args.host = val; break
      case 'pace': args.pace = Number(val) || 1; break
      case 'name': args.name = val; break
      case 'max-tier': args.maxTier = Math.max(1, Math.min(3, Number(val) || 3)); break
      case 'video': args.video = val !== 'false' && val !== '0'; break
      default: console.warn(`[mock-sender] ignoring unknown flag: --${k}`)
    }
  }
  return args
}

// Build ws:// URL + the http:// receiver URL from a host arg that may be a bare
// host:port or a full ws(s):// URL.
function resolveEndpoints(host) {
  let wsBase, httpBase
  if (/^wss?:\/\//.test(host)) {
    wsBase = host.replace(/\/+$/, '')
    httpBase = wsBase.replace(/^ws/, 'http')
  } else {
    wsBase = `ws://${host}`
    httpBase = `http://${host}`
  }
  return { wsBase, httpBase }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv)
const { wsBase, httpBase } = resolveEndpoints(args.host)

const token = hex16()
const key = hex16()
const pairingId = `${token}:${key}`
const receiverUrl = `${httpBase}/#${pairingId}` // §1.2 — fragment = #<token>:<key>

// Connect URL (§1.3). token is urlencoded; key is NEVER sent to the relay.
const connectUrl = `${wsBase}/ws?role=sender&token=${encodeURIComponent(token)}&v=1`

console.log()
console.log('SafeHaven mock sender')
console.log('─────────────────────────────────────────────')
console.log(`  pairingId : ${pairingId}`)
console.log(`  token     : ${token}`)
console.log(`  key       : ${key}  (never sent to relay; encryption seam §9)`)
console.log()
console.log('  OPEN THIS IN THE RECEIVER:')
console.log(`  ${receiverUrl}`)
console.log('─────────────────────────────────────────────')
console.log(`  relay     : ${connectUrl}`)
console.log(`  pace=${args.pace}  video=${args.video ? 'on' : 'off'}  name=${args.name}  maxTier=${args.maxTier}  close=${args.close}`)
console.log()

// Pace helper — scaled setTimeout/setInterval (pace>1 = slower).
const T = (ms) => Math.max(0, Math.round(ms * args.pace))

// --- The OutboundTransform seam (§9) ----------------------------------------
// Every outbound media payload and event payload conceptually passes through
// this boundary. It is an IDENTITY passthrough today; CryptoKit `seal` keyed by
// the pairing `key` slots in HERE later, without touching the relay or framing.
// We construct it WITH the key (plumbed end-to-end now, unused today).
function makeOutboundTransform(pairingKey) {
  // eslint-disable-next-line no-unused-vars
  const _key = pairingKey // reserved for future CryptoKit seal
  return {
    // payload: Buffer | string -> Buffer | string (identity today)
    transform(payload) { return payload },
  }
}
const outbound = makeOutboundTransform(key)

// --- Connection + buffered-before-open send (§8) ----------------------------
let ws = null
let opened = false
const preOpenQueue = [] // frames queued before OPEN, flushed in order on open (§8)

// seq is per-kind monotonic and RESETS on (re)connect (§3 / §8).
let videoSeq = 0
let audioSeq = 0

// Capture-clock origin for ptsMicros.
const startHr = process.hrtime.bigint()
function ptsMicrosNow() {
  return Number((process.hrtime.bigint() - startHr) / 1000n)
}

function sendBinary(frame) {
  enqueueOrSend(frame, true)
}

function enqueueOrSend(frame, isBinary) {
  if (opened && ws && ws.readyState === WebSocket.OPEN) {
    ws.send(frame, { binary: !!isBinary })
  } else {
    preOpenQueue.push({ frame, isBinary })
  }
}

// Build a product-event TEXT frame (§5 envelope). The inner payload object is
// where the OutboundTransform would encrypt (§9); identity today, so we pass the
// object straight through and JSON-stringify it inside the envelope.
function emitEvent(payload) {
  const enriched = { ...payload, timestamp_iso: nowIso() }
  // SEAM (§9): the transform operates on the SERIALIZED payload (identity today),
  // matching the native sender's bytes-based OutboundTransform so turning on
  // crypto is a symmetric, localized change. The envelope `type` stays cleartext.
  const transformedPayload = outbound.transform(JSON.stringify(enriched))
  enqueueOrSend(`{"type":"event","payload":${transformedPayload}}`, false)
}

// ---------------------------------------------------------------------------
// GPS trail — a slow walk around Barcelona (~41.3874, 2.1686) so the receiver's
// map/trail is visibly moving (§5.1 enriched gps_update).
// ---------------------------------------------------------------------------
const BCN = { lat: 41.3874, lng: 2.1686 }
let gpsStep = 0
function nextGps() {
  // Spiral-ish drift: ~a few meters per step. 0.00008 deg lat ≈ 9 m.
  const t = gpsStep++
  const lat = BCN.lat + Math.sin(t / 6) * 0.00045 + t * 0.00003
  const lng = BCN.lng + Math.cos(t / 6) * 0.00045 + t * 0.00002
  const heading = (Math.atan2(Math.cos(t / 6), -Math.sin(t / 6)) * 180) / Math.PI
  return {
    event_type: 'gps_update',
    lat: Number(lat.toFixed(6)),
    lng: Number(lng.toFixed(6)),
    accuracy: Number((5 + Math.random() * 8).toFixed(1)), // meters
    speed: Number((0.8 + Math.random() * 1.6).toFixed(2)), // m/s (walking)
    heading: Number(((heading + 360) % 360).toFixed(1)),   // degrees
    altitude: Number((12 + Math.random() * 6).toFixed(1)), // meters
    address: null,
  }
}

// ---------------------------------------------------------------------------
// AI labels — cycle through several of the 9 valid labels (§5.3) with clamped
// confidences (§5.1: confidence MUST be clamped to [0,1]).
// raw_identifier mirrors the normalized Apple identifier the Swift mapping uses.
// ---------------------------------------------------------------------------
const AI_CYCLE = [
  { label: 'SHOUTING', raw_identifier: 'shout', confidence: 0.78 },
  { label: 'SCREAMING', raw_identifier: 'screaming', confidence: 0.92 },
  { label: 'GLASS_BREAKING', raw_identifier: 'glass_breaking', confidence: 0.85 },
  { label: 'IMPACT', raw_identifier: 'thump_thud', confidence: 0.71 },
  { label: 'CRYING', raw_identifier: 'crying_sobbing', confidence: 0.66 },
  { label: 'IMPACT', raw_identifier: 'gunshot_gunfire', confidence: 0.94 }, // loud bang -> loud impact (no firearm claim)
  { label: 'DOOR_SLAM', raw_identifier: 'door_slam', confidence: 0.69 },
  { label: 'SLAP', raw_identifier: 'slap_smack', confidence: 0.63 },
  { label: 'EXTENDED_SILENCE', raw_identifier: 'silence', confidence: 1.0 },
]
const clamp01 = (x) => Math.max(0, Math.min(1, x))
let aiIdx = 0
function nextAiLabel() {
  const e = AI_CYCLE[aiIdx++ % AI_CYCLE.length]
  return {
    event_type: 'ai_label',
    label: e.label,
    confidence: clamp01(e.confidence),
    source: 'SoundAnalysis',
    raw_identifier: e.raw_identifier,
  }
}

// Codeword tier escalation is monotonic +1: sunny@0->1, cloudy@1->2, stormy@2->3
// (§ contract). incident_opened (HOLD) fires the 0->1 transition; subsequent
// escalations are tier_changed with trigger "codeword".
let currentTier = 0

// ---------------------------------------------------------------------------
// Scheduled timers (cleared on shutdown).
// ---------------------------------------------------------------------------
const timers = new Set()
const every = (ms, fn) => { const id = setInterval(fn, T(ms)); timers.add(id); id.unref?.(); return id }
const after = (ms, fn) => { const id = setTimeout(fn, T(ms)); timers.add(id); return id }
function clearAllTimers() { for (const id of timers) { clearInterval(id); clearTimeout(id) } timers.clear() }

let mediaStarted = false
function startMediaStreams() {
  if (mediaStarted) return
  mediaStarted = true

  // Audio: REAL 16 kHz Int16 sine, 20 ms chunks, kind=AUDIO_PCM, cacheClass=none.
  const sine = makeSineSource(440, 0.22)
  every(CHUNK_MS, () => {
    const payload = sine() // outbound.transform(payload) would encrypt later (§9)
    sendBinary(buildFrame({
      kind: KIND_AUDIO_PCM,
      flags: 0,
      cacheClass: CACHE_NONE,
      seq: audioSeq++,
      ptsMicros: ptsMicrosNow(),
      payload: outbound.transform(payload),
    }))
  })

  // Video (Tier ≥ 2 per §0, but the mock starts it alongside audio once we hit
  // the run loop for simpler testing — the receiver doesn't gate on tier). ~12
  // fps placeholder; KEYFRAME (IDR) forced every 2 s (§4.1 IDR cadence).
  if (args.video) {
    const FPS = 12
    const FRAME_MS = Math.round(1000 / FPS)
    const KEYFRAME_EVERY = Math.round((2000 / FRAME_MS)) // ~every 2 s
    let frameNo = 0
    every(FRAME_MS, () => {
      const isKey = frameNo % KEYFRAME_EVERY === 0
      const payload = makePlaceholderVideoPayload(isKey)
      sendBinary(buildFrame({
        kind: KIND_VIDEO_H264,
        flags: isKey ? FLAG_KEYFRAME : 0,
        cacheClass: isKey ? CACHE_RETAIN_LAST : CACHE_NONE, // retain last IDR (§3)
        seq: videoSeq++,
        ptsMicros: ptsMicrosNow(),
        payload: outbound.transform(payload),
      }))
      frameNo++
    })
  }
}

// ---------------------------------------------------------------------------
// The scripted incident timeline.
// ---------------------------------------------------------------------------
function runScript() {
  // T0 — session opens at Tier 1. incident_start carries the display name (§5.2),
  // then incident_opened (HOLD, only fired from Tier 0, §5.1). Both fire
  // synchronously with reaching Tier ≥ 1 (§8).
  emitEvent({
    event_type: 'incident_start',
    person_name: args.name,
    app_version: '1.0',
    tier: 1,
    trigger: 'hold',
  })
  emitEvent({ event_type: 'incident_opened', tier: 1, trigger: 'hold' })
  currentTier = 1
  console.log('[script] T1 — incident_start + incident_opened (HOLD)')

  // Audio (+video) begin now. (Per §0 video starts at Tier ≥ 2; the mock starts
  // both here for test convenience — documented in the file header.)
  startMediaStreams()

  // Periodic GPS — one update every ~3 s (real cadence is ~1/5 s; faster here so
  // the trail builds quickly in a demo). Enriched fields per §5.1.
  every(3000, () => emitEvent(nextGps()))
  // Kick one out immediately so the map isn't empty for 3 s.
  emitEvent(nextGps())

  // Periodic AI labels — one every ~4 s, cycling the 9 labels (§5.3).
  every(4000, () => emitEvent(nextAiLabel()))
  after(1500, () => emitEvent(nextAiLabel()))

  // Tier escalations via codeword (monotonic +1), spaced out (§5.1 / contract).
  if (args.maxTier >= 2) {
    after(6000, () => {
      currentTier = 2
      emitEvent({ event_type: 'tier_changed', tier: 2, trigger: 'codeword' })
      console.log('[script] T2 — tier_changed (codeword)')
    })
  }
  if (args.maxTier >= 3) {
    after(12000, () => {
      currentTier = 3
      emitEvent({ event_type: 'tier_changed', tier: 3, trigger: 'codeword' })
      console.log('[script] T3 — tier_changed (codeword)')
    })
  }

  // Optionally close the incident and exit. Otherwise stay live until Ctrl-C so
  // a human can join late and observe the full back-timeline replay.
  if (args.close) {
    const closeAt = 20000
    after(closeAt, () => {
      const durationMs = Math.round(closeAt * args.pace)
      emitEvent({ event_type: 'incident_closed', duration_ms: durationMs })
      console.log(`[script] incident_closed (duration_ms=${durationMs}) — exiting shortly`)
      after(800, () => shutdown('script-complete'))
    })
  } else {
    console.log('[script] streaming live — Ctrl-C to stop. Open the receiver URL above; join late to see full replay.')
  }
}

// ---------------------------------------------------------------------------
// Connect with auto-reconnect + backoff (§8): start 2000 ms, ×1.5 per close,
// cap 30000 ms, reset to 2000 on open. seq resets on reconnect (above).
// ---------------------------------------------------------------------------
let backoff = 2000
let reconnectTimer = null
let shuttingDown = false
let scriptStarted = false

function connect() {
  if (shuttingDown) return
  clearTimeout(reconnectTimer)
  console.log(`[ws] connecting → ${connectUrl}`)
  ws = new WebSocket(connectUrl)
  ws.binaryType = 'nodebuffer'

  ws.on('open', () => {
    opened = true
    backoff = 2000 // reset on open (§8)
    // Reset per-kind seq on (re)connect (§3 / §8).
    videoSeq = 0
    audioSeq = 0
    console.log('[ws] open')

    // Optional hello (§6.1): role/token already in the query; hello carries v.
    ws.send(JSON.stringify({ type: 'hello', v: 1 }))

    // Flush anything buffered before OPEN, in order (§8 buffer-before-open).
    while (preOpenQueue.length) {
      const { frame, isBinary } = preOpenQueue.shift()
      ws.send(frame, { binary: !!isBinary })
    }

    // Start the scripted incident exactly once (idempotent start, §8). On a
    // reconnect we keep streaming; we do NOT re-fire incident_start (that would
    // clear the relay's session log).
    if (!scriptStarted) {
      scriptStarted = true
      runScript()
    }
  })

  // Relay → sender control is presence-only (§6.2).
  ws.on('message', (data, isBinary) => {
    if (isBinary) return
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }
    if (msg.type === 'presence') {
      console.log(`[presence] ${msg.event} (receivers=${msg.receivers})`)
      // A real sender would ensure it's encoding for the tier and force an IDR
      // here (§6.2). For the mock, the IDR cadence already covers resync within
      // ≤2 s, so we just log.
    }
  })

  ws.on('close', (code, reason) => {
    opened = false
    console.log(`[ws] close code=${code} reason=${reason?.toString() || ''}`)
    if (shuttingDown) return
    // Fatal close codes (§10) — don't pointlessly retry on protocol rejection.
    if (code === 4000 || code === 4001 || code === 4002 || code === 4003) {
      console.error(`[ws] fatal close ${code} — not reconnecting. Check role/token/version (is another sender already on this token?).`)
      shutdown('fatal-close')
      return
    }
    console.log(`[ws] reconnecting in ${backoff} ms`)
    reconnectTimer = setTimeout(connect, backoff)
    backoff = Math.min(30000, Math.round(backoff * 1.5)) // ×1.5, cap 30 s (§8)
  })

  ws.on('error', (err) => {
    console.warn(`[ws] error: ${err?.message || err}`)
    // 'close' will follow and drive reconnect.
  })
}

function shutdown(why) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[mock-sender] shutting down (${why})`)
  clearAllTimers()
  clearTimeout(reconnectTimer)
  try { ws?.close(1000, 'mock sender done') } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 300).unref?.()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

connect()
