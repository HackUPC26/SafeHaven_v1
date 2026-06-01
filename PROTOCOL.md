# SafeHaven v1 — Wire Protocol

**Status:** DRAFT for ratification. Do not build until signed off.
**Protocol version:** `1`
**Transport:** a single server-mediated WebSocket per participant, through a relay keyed by session token. No WebRTC, no Hypercore, no peer-to-peer.

This document is the single source of truth that the **sender** (native Swift), the **relay** (Node `ws`), and the **receiver** (Vite + React) all implement. Because one author builds all three, the only hard requirement is internal consistency — but every shape here is fixed once this is signed off. If anything below needs to change after sign-off, we stop and re-ratify.

---

## 0. Decisions baked into this draft

These were settled before writing (see conversation):

| Decision | Choice |
|---|---|
| Late-joiner / reconnect catch-up | **Relay is stateful**: it retains the **full session event log** (every `incident_start` / tier change / GPS update / AI label since the session opened) plus the last video keyframe, and replays the lot to any receiver on join — so a contact who opens the link mid-incident sees the **entire timeline from the start**, not just the current state. |
| Receiver build | **Vite + React** app. |
| Event enrichments | **Richer GPS** (accuracy/speed/heading/altitude/address), **real display name** via `incident_start`, **trigger provenance** field — all backward-compatible additions. |
| On-device persistence | **Consent-gated local incident store** in the Swift sender. Relay still persists nothing to disk. SQLite hash-chain evidence log deferred. |
| Video codec | **H.264** (not HEVC), fixed **720p**, single target bitrate **~2 Mbps**, VideoToolbox encode → WebCodecs `VideoDecoder` → `<canvas>`. No MSE, no adaptive bitrate. |
| Audio codec | **Raw PCM** (no codec) over the socket, played via Web Audio. (On-device SoundAnalysis runs on the raw mic buffer separately and is untouched.) |
| Video start gate | Video encode/stream begins at **Tier ≥ 2** (per the brief's tier model; note the legacy RN app started it at T1). Audio + GPS + classification begin at **Tier ≥ 1**. |

> **Statefulness note.** The brief originally called the relay a "stateless dumb pipe." We are deliberately overriding that: the relay keeps an in-memory **session event log** per token (§7). It still (a) writes **nothing to disk**, (b) logs **no payload content** (connection metadata only), (c) drops the entire log when the room is torn down, and (d) **never decrypts or parses payloads** — it appends/replays product-event frames verbatim and routes media off the cleartext frame header. This reconciles "full timeline on join" with the future encryption seam (§9).

---

## 1. Session pairing, auth, and routing

### 1.1 Pairing ID

```
pairingId = "<token>:<key>"
```

- `token` — the relay room/session identifier. **Cryptographically random hex, 32 chars (16 bytes)**, generated on the sender with `SecRandomCopyBytes` (replaces the legacy Hypercore-pubkey derivation and the old `Math.random` hex). This is the **only** value the relay uses for routing.
- `key` — reserved for the future end-to-end encryption layer (§9). **Also `SecRandomCopyBytes`, 32 hex chars.** Unused today, but plumbed end to end on both sender and receiver.

The pairing ID is shown in the sender's hidden Settings as a QR code + selectable receiver URL, exactly as today.

### 1.2 Receiver URL

```
https://<relay-host>/#<token>:<key>
```

> **Change from today.** The legacy receiver put only `<token>` in the fragment and read the *entire* hash as the token. The v1 receiver **MUST split on the first `:`**, use the left side as `token`, and retain the right side as `key` (passed to the `InboundTransform`, §9). Anything after a second `:` is reserved/ignored.

### 1.3 WebSocket connect

```
wss://<relay-host>/ws?role=<sender|receiver>&token=<urlencoded token>&v=1
```

- `role` ∈ `sender` | `receiver`; any other value → relay closes with code `4000`.
- `token` is required; missing/empty → close `4001`.
- `v` is the protocol version; mismatch → close `4003` (relay may also tolerate and warn — see §10).
- **One sender per token.** A second live sender on the same token is rejected with close `4002`. Many receivers per token are allowed.
- **Scheme:** production is `wss://`. Local dev may use `ws://` against `localhost`/LAN (see README ATS notes). The `key` is **never** sent to the relay; it lives only in the URL fragment and on the client.

---

## 2. Transport overview

One WebSocket carries everything, using the two native frame types:

| WebSocket frame | Carries | Encoding |
|---|---|---|
| **Text** (`string` / `WebSocket.send(string)`) | Control + product events | UTF-8 JSON |
| **Binary** (`ArrayBuffer` / `Data`) | Media (H.264 video, PCM audio) | Cleartext header + opaque payload (§3) |

This split is unambiguous on both ends: `URLSessionWebSocketTask` delivers `.string` vs `.data`; the browser `WebSocket` delivers `string` vs `ArrayBuffer` (set `ws.binaryType = "arraybuffer"`). The receiver routes on frame type first, then on `kind`/`type`.

The relay forwards both frame types **verbatim** sender→all-receivers (and the few receiver→sender control frames), caching by header only.

---

## 3. Binary media framing

Every binary frame is a fixed **16-byte little-endian header** followed by an opaque payload. The header is **always cleartext**; the payload is what the encryption seam (§9) will encrypt later.

```
offset size  field        notes
0      1     version      = 0x01
1      1     kind         1 = VIDEO_H264, 2 = AUDIO_PCM
2      1     flags        bit0 = KEYFRAME (IDR) for video; for audio, 0
3      1     cacheClass   0 = none (do not retain), 1 = retain-last-of-kind
4      4     seq          uint32, per-(kind) monotonic sequence from the sender
8      8     ptsMicros    uint64, presentation timestamp in microseconds (capture clock)
16     ...   payload      encoded video access unit OR PCM chunk (opaque to relay)
```

- **`kind`** is the only thing the relay needs to route/cache media; it never inspects the payload.
- **`flags.KEYFRAME`** lets the relay identify and retain the latest IDR (see §4.1, §7).
- **`cacheClass`** is set by the sender. For media, only the **latest IDR video frame** uses `retain-last-of-kind`; audio and delta video frames use `none`.
- **`seq`** lets the receiver detect loss/reorder per stream. **`ptsMicros`** feeds the WebCodecs `EncodedVideoChunk.timestamp` and audio scheduling.

> Endianness is little-endian for all multi-byte header fields. The receiver parses with a `DataView`; the sender writes with explicit byte order.

---

## 4. Media encoding

### 4.1 Video — H.264, 720p, ~2 Mbps

**Sender (VideoToolbox):**
- `AVCaptureSession`, front camera, fixed **1280×720**, ~24–30 fps.
- VideoToolbox `VTCompressionSession`, codec `kCMVideoCodecType_H264`, `AverageBitRate ≈ 2_000_000`, `ProfileLevel = Baseline/Main AutoLevel` (Baseline maximizes browser decode compatibility), `RealTime = true`, `AllowFrameReordering = false` (no B-frames → lower latency, simpler decode).
- **IDR cadence:** force a keyframe **every 2 seconds** (`kVTEncodeFrameOptionKey_ForceKeyFrame`) and set `MaxKeyFrameInterval ≈ 2 × fps`. Rationale: the relay caches one IDR; a fresh/reconnecting receiver starts decoding within ≤2 s.
- **Bitstream format:** VideoToolbox emits **AVCC** (length-prefixed NAL units) with SPS/PPS in the format description. The sender **converts to Annex-B** (4-byte `00 00 00 01` start codes) and **prepends SPS + PPS to every IDR access unit** so each keyframe is independently decodable. Delta frames are Annex-B without parameter sets.
  - Each Annex-B access unit = one binary frame, `kind = VIDEO_H264`, `flags.KEYFRAME` set on IDR, `cacheClass = retain-last-of-kind` on IDR (else `none`).

**Receiver (WebCodecs):**
- Feature-detect `window.VideoDecoder`. If absent → **graceful fallback** (§4.3).
- `VideoDecoder` config: `{ codec: "avc1.42E01F", optimizeForLatency: true }` (Baseline 3.1; the receiver may refine the level from the SPS). **No `description`** → Annex-B in-band mode, which is why the sender ships SPS/PPS in-band with each IDR.
- Drop frames until the first `KEYFRAME` arrives; feed `EncodedVideoChunk({ type: key?"key":"delta", timestamp: ptsMicros, data: payload })`. Render `VideoFrame`s to a `<canvas>` (`createImageBitmap`/`drawImage` or `canvas.drawImage(frame)`), then `frame.close()`.
- **Staleness:** track last decoded frame time; if no frame for >N seconds show the existing "FEED FROZEN · Ns since last frame" overlay (parity with today).

### 4.2 Audio — raw PCM

- **Format:** 16-bit **signed integer, little-endian, mono, 16 kHz**. Chunk ≈ **20 ms** (320 samples = 640 bytes payload). `kind = AUDIO_PCM`, `cacheClass = none`.
- **Sender:** tap the streaming capture path, downsample/convert to 16 kHz Int16 mono, packetize into 20 ms chunks. (Independent of the SoundAnalysis tap — see §5.4 / §8.)
- **Receiver (Web Audio):** maintain an `AudioContext`; for each chunk convert Int16→Float32 (`/ 32768`), wrap in an `AudioBuffer`, and schedule on a running playout clock for gapless playback. Resume the suspended `AudioContext` on first user gesture (Safari autoplay policy) — keep today's "tap to enable audio" affordance.
- The receiver's live-waveform analyser (44 bars) reads **decoded PCM levels** instead of a MediaStream analyser node.

> PCM params (sample rate, bit depth, chunk size) are tunable; these defaults keep audio at ~256 kbps — negligible next to video, and bulletproof to decode.

### 4.3 WebCodecs-unavailable fallback

If `VideoDecoder` is missing (or `VideoDecoder.isConfigSupported` rejects H.264), the session **must not hard-fail**: the receiver shows a "Video unavailable in this browser" state in the video panel and keeps **audio, GPS, AI labels, tier banner, and timeline fully live**. The sender still streams normally; only that one receiver's video panel degrades.

---

## 5. Control + product events (text / JSON)

All control and product events are **UTF-8 JSON text frames**. Product events keep the legacy envelope so the receiver's `translateEvent` logic ports with minimal change:

```json
{ "type": "event", "payload": { "event_type": "...", ... , "timestamp_iso": "<ISO8601>" } }
```

- **`timestamp_iso`** is present on **every** product event. ISO-8601 UTC, millisecond precision, trailing `Z` (Swift: `ISO8601DateFormatter` with `.withInternetDateTime` + `.withFractionalSeconds`).
- Non-product control frames (session/presence) use other `type` values (§6).

### 5.1 The product events

Base shapes are **unchanged** from the hackathon wire; the agreed enrichments are **additive** (older readers ignore unknown keys).

```jsonc
// incident_opened — fired ONLY by the 3s hold trigger, ONLY from Tier 0
{ "event_type": "incident_opened", "tier": 1, "trigger": "hold", "timestamp_iso": "..." }

// tier_changed — fired by codewords (monotonic +1) and any other escalation
{ "event_type": "tier_changed", "tier": 2, "trigger": "codeword", "timestamp_iso": "..." }

// gps_update — base {lat,lng}; enriched fields optional/null-safe
{ "event_type": "gps_update", "lat": 41.3874, "lng": 2.1686,
  "accuracy": 8.0, "speed": 1.2, "heading": 270.0, "altitude": 14.0,
  "address": null, "timestamp_iso": "..." }

// ai_label — confidence MUST be clamped to [0,1] before sending
{ "event_type": "ai_label", "label": "GUNSHOT", "confidence": 0.91,
  "source": "SoundAnalysis", "raw_identifier": "gunshot_gunfire", "timestamp_iso": "..." }

// incident_start — NEW: sent by the sender at session open with the configured display name
{ "event_type": "incident_start", "person_name": "Maria",
  "app_version": "1.0", "tier": 1, "trigger": "hold", "timestamp_iso": "..." }

// incident_closed — optional, on explicit stop / de-escalation to Tier 0
{ "event_type": "incident_closed", "duration_ms": 184000, "timestamp_iso": "..." }
```

**`trigger`** ∈ `hold` | `codeword` | `ai_auto` | `manual`. The receiver should read it (falling back to `"codeword"` only if absent, for back-compat) so the incident log shows the real cause.

**`label`** is one of the 9 valid labels (§5.3). **`raw_identifier`** is the normalized Apple identifier; carried end-to-end even though today's receiver UI doesn't surface it.

### 5.2 incident_start and session opening

The sender emits `incident_start` **first**, synchronously with reaching Tier ≥ 1, carrying the configured display name (from Settings). The receiver uses it to open the session (replacing today's client-side `ensureSession` synthesis of `"Sender <token-prefix>"`). For resilience the receiver **still** synthesizes a session on the first *any* signal if `incident_start` was missed — but a real name is now the normal path.

### 5.3 AI labels — ported verbatim from `SafeHavenAIModule.swift`

The 9 valid labels and the on-device mapping/constants are **unchanged** and re-implemented in Swift exactly:

- **Labels:** `SHOUTING, SCREAMING, CRYING, IMPACT, GUNSHOT, SLAP, DOOR_SLAM, GLASS_BREAKING, EXTENDED_SILENCE`.
- **`safeHavenLabel(for:)` mapping** (identifier normalized → lowercase, space/dash → `_`):
  - `SHOUTING` ← `shout` | `yell` | `children_shouting` | contains `shout`/`yell`
  - `SCREAMING` ← `screaming` | `battle_cry` | contains `scream`
  - `CRYING` ← `crying_sobbing` | `baby_crying` | contains `crying`/`sobbing`
  - `IMPACT` ← `thump_thud` | `crushing` | `boom` | `hammer` | `knock` | `tap` | `wood_cracking` | `chopping_wood`
  - `GUNSHOT` ← `gunshot_gunfire`
  - `SLAP` ← `slap_smack`
  - `DOOR_SLAM` ← `door_slam`
  - `GLASS_BREAKING` ← `glass_breaking` | `glass_clink`
  - `EXTENDED_SILENCE` ← silence timer (not the table)
- **Constants:** `SNClassifySoundRequest(classifierIdentifier: .version1)`, `overlapFactor = 0.5`, `confidenceThreshold = 0.60`, `duplicateSuppressionSeconds = 2.0` (**per-label**), `extendedSilenceSeconds = 5.0`, tap `bufferSize = 8192`, `AVAudioSession .playAndRecord/.measurement [.mixWithOthers, .allowBluetoothHFP]`, serial queue `safehaven.ai.sound-analysis`.
- **Pipeline semantics:** check only the **top** classification for `silence`; otherwise reset the silence timer and emit the **first** classification that is ≥0.60 **and** maps to a label (one label per result). `confidence` is **clamped to [0,1]** before forming the `ai_label` event; `source` defaults to `"SoundAnalysis"`.

### 5.4 Two audio consumers, one capture graph

SoundAnalysis (§5.3) runs on the raw mic buffer and is **separate** from the streamed PCM (§4.2). Per the brief, both fan out from a **single `AVAudioEngine`** (and a single `AVCaptureSession` for video) — no duplicate capture sessions. The engine's input tap feeds (a) the `SNAudioStreamAnalyzer` and (b) the PCM downsample/packetizer.

---

## 6. Session lifecycle and relay routing

### 6.1 Frame classes the relay understands (header/`type` only)

- **Text `{type:"event", ...}`** — product event. Relay forwards to all receivers; may cache (§7).
- **Text `{type:"presence", ...}`** — relay→sender notification that a receiver joined/left (so the sender can re-emit, and start/stop encoding). Relay-generated.
- **Text `{type:"hello", ...}`** — optional client→relay announce on (re)connect (role/token are already in the query string; `hello` carries `v` and is reserved for future negotiation).
- **Binary** — media (§3). Relay forwards to all receivers; caches the latest IDR.

There is **no** SDP/ICE/offer/answer/`receiver-joined` WebRTC machinery. The only relay→sender control is `presence`.

### 6.2 Presence

When a receiver joins a token that has a live sender, the relay sends the sender:
```json
{ "type": "presence", "event": "receiver_joined", "receivers": <count> }
```
and on the last receiver leaving:
```json
{ "type": "presence", "event": "receiver_left", "receivers": <count> }
```
The sender uses `receiver_joined` to (a) ensure it is encoding/streaming for the current tier and (b) **force an IDR** so the new viewer resyncs fast. (The cached snapshot already covers state; the forced IDR minimizes video join latency.)

### 6.3 One sender, N receivers

Routing is pure fan-out keyed by `token`: sender→all receivers for events and media; receiver→sender only for `hello`/future control. No per-receiver addressing (the WebRTC `peerId` model is gone).

---

## 7. Relay session log (the stateful decision)

The relay keeps, **in memory only, per token**, a `RoomState`:

```
RoomState {
  sender:       WebSocket | null
  receivers:    Map<connId, WebSocket>
  eventLog:     Array<text frame>        // EVERY product event since the session opened, in arrival order
  lastVideoIDR: <binary frame> | null    // last binary frame with flags.KEYFRAME set
}
```

- **What it retains:** every sender-origin product event (text frame with `type:"event"`) is **appended verbatim** to `eventLog` in arrival order. The relay does **not** parse the inner `payload` or `event_type` — it stores and replays the opaque frame. For binary media it retains only the **last IDR** (frame with `flags.KEYFRAME`); audio and delta video are never retained. (Replaying the full media stream is neither possible nor useful — the event log is the timeline; the last IDR lets video resync.)

- **Replay on join — the full timeline.** When a receiver connects, the relay atomically sends it the **entire `eventLog` in order**, then `lastVideoIDR`. The receiver replays the log through the same `translateEvent` path as live events and reconstructs the complete incident timeline since the session began: every tier change, every GPS point (and thus the current position + movement trail), every AI label, and the session header — exactly as if it had been watching from the start. Live frames are queued and delivered only **after** the replay completes, so the receiver never interleaves history with live (§8).

- **Session boundary.** `eventLog` begins on the first `incident_start` for the token (a fresh `incident_start` **clears** any prior log — a new session). It is retained through `incident_closed` (so a late joiner sees that the incident ended) and is dropped entirely when the room is torn down (`!sender && receivers.size === 0`).

- **Memory bound (no silent truncation).** `eventLog` is capped at a high safety limit (default **10,000 events**, §11). GPS (~1 per 5 s) and AI labels are low-rate, so a multi-hour incident stays far under. If the cap is ever hit, the relay drops the oldest events **and emits a connection-log line noting the truncation** — it never silently discards history.

- **No disk. No payload logging. No decryption.** The log lives in RAM and is dropped on teardown. The relay logs connection events only (connect/disconnect/counts, token-prefixed) and **never** logs frame payloads. Because it stores/replays product-event frames verbatim and routes media off the cleartext binary header alone, it **never reads an event payload** — which is exactly why the deferred encryption layer (§9) can encrypt payloads without changing the relay. The legacy no-role "bridge" branch that `console.log`'d message bodies is **removed**.

---

## 8. Reconnect, buffering, and ordering

- **Connect at session start.** The sender opens the WebSocket the instant it reaches Tier ≥ 1, so the very first `incident_start`/`incident_opened` (fired synchronously with the state change) is captured.
- **Buffer-before-open / flush-on-open.** Events emitted before the socket is `OPEN` are queued and flushed in order on `open`. This preserves the hackathon fix where the first Tier-1 event would otherwise be lost. (Re-implemented in Swift; the relay's cache is a second safety net.)
- **Auto-reconnect with backoff.** Start **2000 ms**, ×1.5 per close, cap **30000 ms**, reset to 2000 on open. On reconnect the client re-announces by reconnecting with the same `role`+`token` (and `hello`); the relay treats it as a fresh connection and (for receivers) replays the cache.
- **Idempotent start.** Re-entering an already-active tier does not open a second socket.
- **Ordering & replay atomicity.** WebSocket preserves per-connection order. On a receiver join the relay sends the **entire `eventLog` then `lastVideoIDR` before any live frame** for that receiver (buffer live frames for that connection until replay is flushed), so history never interleaves with live. `seq` (binary) and `timestamp_iso`/`ptsMicros` let the receiver detect loss and order media. `seq` is per-`kind` monotonic for the life of one sender connection and **resets on sender reconnect**; the receiver treats a `seq` that goes backwards as a stream restart (re-arm "await keyframe") rather than loss.

---

## 9. Encryption seam (deferred — design only)

E2E encryption (CryptoKit) drops in later **without touching the relay or the framing**:

- **Sender:** every outbound media payload and event payload passes through one `OutboundTransform` boundary — an **identity passthrough today**. CryptoKit `seal` slots in here, keyed by the `key` half of the pairing ID.
- **Receiver:** a matching `InboundTransform` passthrough; CryptoKit `open` slots in later, keyed by the `key` parsed from the URL fragment.
- **Relay:** forwards opaque bytes either way. It routes/retains off **cleartext metadata only** — the WebSocket frame type (text vs binary), the text envelope `type` field (to know a frame is a product event worth logging), and the binary header's `KEYFRAME` flag (§3). It **never reads the inner `payload`** (the event object, encoded video AU, or PCM chunk), so it never knows or cares whether payloads are encrypted, and it never changes when encryption lands.
- **Boundary:** `encode → OutboundTransform(encrypt) → send` on the sender; `receive → InboundTransform(decrypt) → decode` on the receiver. Headers/envelopes stay cleartext; only payloads (encoded video AU, PCM chunk, event `payload` object) are transformed.
- The `key` is plumbed end-to-end **now** (sender: from Keychain to the transform constructor; receiver: from the URL fragment to the transform constructor) even though both transforms are no-ops.

Each codebase marks the transform location with a clear comment.

---

## 10. Versioning and close codes

- **Version `1`** in the connect query (`v=1`) and reserved in `hello`. Mismatch → relay may close `4003` or tolerate-and-warn (TBD at deploy; default: warn).
- **Close codes:** `4000` invalid role · `4001` missing token · `4002` sender already connected · `4003` version mismatch.

---

## 11. Tunable parameters (confirm at sign-off)

| Param | Default | Where |
|---|---|---|
| Video resolution / fps | 1280×720 / 24–30 | §4.1 |
| Video target bitrate | ~2 Mbps | §4.1 |
| IDR cadence | every 2 s | §4.1 |
| H.264 profile | Baseline (avc1.42E01F) | §4.1 |
| PCM format | Int16 LE, mono, 16 kHz, 20 ms chunks | §4.2 |
| Event-log safety cap | 10,000 events | §7 |
| Reconnect backoff | 2000 ms ×1.5 cap 30000 ms | §8 |
| Token / key length | 32 hex chars each | §1.1 |

---

## 12. Summary of what changed from the hackathon wire

- WebRTC (SDP/ICE/per-viewer PC) **removed**; one WebSocket of framed blobs replaces it.
- Hypercore/Hyperswarm/Bare **removed**; durable record becomes an optional consent-gated on-device store.
- Relay no longer carries SDP/ICE; it forwards media + events and retains the **full per-session event log** (RAM-only, payload-opaque) which it replays in order to late joiners, plus the last video keyframe.
- `<token>:<key>` now actually appears in the receiver URL and the receiver splits it.
- Video is H.264/720p via VideoToolbox→WebCodecs→canvas; audio is raw PCM via Web Audio. Neither existed before.
- Events gain `trigger`, enriched GPS, a real `incident_start` name; base shapes and `timestamp_iso` unchanged.
- Encryption is a no-op transform seam on sender + receiver; relay is encryption-agnostic by construction.
