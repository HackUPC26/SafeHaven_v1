# SafeHaven v1

Covert personal-safety system, rebuilt on a single server-mediated WebSocket.
A trusted contact opens a link in any browser and watches a live incident —
audio, video, GPS, AI sound labels, and a timeline — streamed from the victim's
phone (disguised as a weather app) through a relay.

> **No WebRTC, no Hypercore, no peer-to-peer.** One WebSocket of framed blobs
> through a relay keyed by a session token. The full wire contract is
> [`PROTOCOL.md`](./PROTOCOL.md) — read it before changing any component.

```
┌──────────────────────────┐        ┌───────────────────────┐        ┌──────────────────────────┐
│  SENDER (native Swift)    │        │  RELAY (Node, stateful) │       │  RECEIVER (Vite + React)   │
│  weather-app disguise     │        │  token-keyed rooms      │       │  browser dashboard         │
│  H.264 (VideoToolbox)     │ ──ws──▶│  fan-out sender→all     │──ws──▶│  WebCodecs → <canvas>      │
│  PCM (AVAudioEngine)      │  one   │  full session-log cache │ N×    │  Web Audio (PCM)           │
│  GPS (CLLocationManager)  │ socket │  replays timeline+IDR   │       │  GPS map + trail + timeline│
│  SoundAnalysis → ai_label │        │  to late joiners        │       │  Call-Police @ Tier 3      │
└──────────────────────────┘        └───────────────────────┘        └──────────────────────────┘
        encrypt seam (identity today, §9) ─────────────────────────── decrypt seam (identity today)
                              relay forwards opaque payloads, never decrypts
```

## Repository layout

| Path | What |
|---|---|
| [`PROTOCOL.md`](./PROTOCOL.md) | Ratified wire protocol — the single source of truth for all three components |
| [`relay/`](./relay/) | Node `ws` relay (stateful session-log; replays the timeline to late joiners) |
| [`receiver/`](./receiver/) | Vite + React + TypeScript browser dashboard |
| [`sender/`](./sender/) | Native Swift/SwiftUI iOS 17 app (XcodeGen project) |
| [`tools/mock-sender/`](./tools/mock-sender/) | Scripted sender for testing the receiver without a phone |

Each directory has its own README with component-specific detail.

`SafeHaven/` (sibling of this folder) is the **read-only** hackathon reference
(React-Native sender, WebRTC receiver, signaling server). It is never modified.

---

## Prerequisites

- **Relay:** Node **≥ 20**. Dependency: `ws` (installed via `npm install`).
- **Receiver:** Node **≥ 20** (Vite 5, React 18, TypeScript 5.6). A browser with
  **WebCodecs + H.264** for live video (Chrome/Edge, Safari 16.4+). Browsers
  without WebCodecs still get audio, GPS, AI labels, and the timeline — only the
  video panel shows an "unavailable" state (§4.3).
- **Sender:** macOS with **Xcode 15+** (ships the iOS 17 SDK), **Swift 5.9**,
  **XcodeGen** (`brew install xcodegen`), and a **physical iPhone on iOS 17+**.
  Camera and `SoundAnalysis` are unavailable in the Simulator, so a real device
  is required for a full run. **No third-party Swift dependencies** —
  `URLSessionWebSocketTask`, VideoToolbox, SoundAnalysis, and CoreLocation are
  all native.

---

## Build & run each component

### 1. Relay
```bash
cd relay
npm install
npm start                 # listens on :8080
# options: PORT=9000 npm start   |   MAX_EVENT_LOG=5000 npm start   |   STRICT_VERSION=1 npm start
```
In **production** the relay also static-serves the receiver's built bundle
(`receiver/dist`) on the same port — one origin for page + socket. In **dev** the
receiver runs on its own Vite server (below) and proxies `/ws` to the relay.

### 2. Receiver
```bash
cd receiver
npm install
npm run dev               # http://localhost:5173  (proxies /ws → ws://localhost:8080)
# open with a pairing fragment:  http://localhost:5173/#<token>:<key>
npm run build             # production bundle → receiver/dist (served by the relay)
npm run typecheck         # tsc --noEmit
```

### 3. Sender (physical iPhone)
```bash
cd sender
brew install xcodegen     # one-time
xcodegen generate         # creates SafeHaven.xcodeproj from project.yml
open SafeHaven.xcodeproj   # set your Development Team under Signing, then Run on a device
```
Point the app at your relay: set `SafeHavenRelayHost` (and `SafeHavenRelayUsesTLS`)
in `App/Info.plist`, or override the host live in the hidden Settings screen.

### 4. Mock sender (test the receiver without a phone)
```bash
cd tools/mock-sender
npm install
node mock-sender.js        # prints a receiver URL; drives a full scripted incident
# variants: --no-video  |  --pace=2 (slower)  |  --name=Alex  |  --max-tier=2  |  --close
```

---

## Full local end-to-end test

### Path A — relay + mock-sender + receiver (no phone needed)
1. **Relay:** `cd relay && npm install && npm start`
2. **Receiver (dev):** `cd receiver && npm install && npm run dev`
3. **Mock sender:** `cd tools/mock-sender && npm install && node mock-sender.js`
   It prints a pairing URL like `http://localhost:8080/#<token>:<key>`. For the
   Vite dev server, open it on the **dev origin** instead:
   `http://localhost:5173/#<token>:<key>`.
4. Watch the dashboard populate: session header + name, tier escalations
   (Tier 1 → 2 → 3), a moving GPS trail around Barcelona, cycling AI labels, and
   **live audio you can actually hear** (tap once to enable audio — Safari/Chrome
   autoplay policy).
5. **Late-join / full-timeline replay test:** leave the mock sender streaming
   (omit `--close`), then open the receiver URL in a **second tab a minute later**.
   The relay replays the **entire event log from the start** (then the last
   keyframe) before live frames resume — the late tab shows the whole incident,
   not just the current moment.

> **Video note:** the mock sender emits correctly-*framed* but **placeholder**
> H.264 (a real H.264 encoder in pure Node is out of scope). The relay frames,
> caches, and replays it correctly, but the browser's WebCodecs decoder will
> reject the bytes — so the video panel shows "frozen/unavailable." **This is
> expected, not a bug.** Use `--no-video` for a clean audio-only run, or use the
> real Swift sender (below) to verify decode. Audio is genuinely synthesized PCM
> and plays.

### Path B — full system (Swift sender on a device)
1. Run the relay on a host reachable from the phone (your Mac's LAN IP, or a VPS).
2. Build & run the sender on the iPhone (above); set the relay host accordingly.
3. Open the receiver URL (from the sender's hidden Settings QR/link) in a browser.
4. **Trigger an incident** (see below) and watch real camera video (H.264 via
   VideoToolbox → WebCodecs → canvas), live mic audio, GPS, and on-device
   `SoundAnalysis` labels stream through.

---

## Trigger reference (sender)

The app looks and behaves like an ordinary "Barcelona" weather app. The safety
controls are covert:

| Action | Gesture | Effect |
|---|---|---|
| **Open incident** | Press-and-hold the **`H:24°  L:15°`** row for **3 s** (a subtle fill animates) | Opens at **Tier 1** (`incident_opened`, trigger `hold`) — only from idle |
| **Escalate** | Type a codeword in the **"Search weather…"** field | `sunny` → T1, `cloudy` → T2, `stormy` → T3 (`tier_changed`, trigger `codeword`) |
| **Hidden settings** | Long-press the city name **"Barcelona"** for **~2 s** | Display name, codewords, pairing QR/URL, relay host, consent toggle, reset |

Escalation is **monotonic, one step at a time** (T0→T1→T2→T3); you cannot skip or
reverse tiers. **Tiers:** T0 idle (disguise only) · T1 audio + GPS + sound
classification · T2 adds video · T3 emergency. The only visible cue is a subtle
status dot (amber T1/T2, red T3).

---

## Configuration / environment

- **Relay:** `PORT` (default `8080`), `MAX_EVENT_LOG` (default `10000`),
  `STRICT_VERSION` (optional; `1` closes mismatched protocol versions with 4003
  instead of warn-and-allow). **No other env vars.**
- **Receiver:** **no env vars.** It connects same-origin to `/ws`; the dev proxy
  target lives in `receiver/vite.config.ts` (`ws://localhost:8080`).
- **Sender:** **no env vars** (it's a native app). The relay host — the analogue
  of the old `EXPO_PUBLIC_SIGNAL_HOST` — is set via the `SafeHavenRelayHost` /
  `SafeHavenRelayUsesTLS` keys in `App/Info.plist`, overridable at runtime in the
  hidden Settings screen.

---

## What changed from the hackathon version

- **Transport:** WebRTC (SDP/ICE, per-viewer peer connections, STUN) → **one
  WebSocket of framed blobs** through the relay. Audio/video/GPS/events all share
  it. `URLSessionWebSocketTask` on the sender, native `WebSocket` in the browser.
- **Hypercore / Hyperswarm / Bare worklet — removed.** The on-device append-log
  and DHT replication are gone. The durable record is now an optional
  **consent-gated on-device incident store** in the Swift app (the SQLite
  hash-chain evidence log is a separate, later workstream).
- **Relay** (renamed from `p2p-hello`) carries no SDP/ICE; it forwards media +
  events and is **stateful**: it retains the **full per-session event log** and
  replays the whole timeline (plus the last keyframe) to any receiver that joins
  late or reconnects. It is RAM-only, persists nothing to disk, logs no payloads,
  and never reads inside a payload — so it stays encryption-agnostic.
- **Sender is native Swift/SwiftUI** (was React Native/Expo): VideoToolbox H.264
  720p, raw PCM from a single `AVAudioEngine`, `CLLocationManager` GPS, and the
  `SoundAnalysis` classifier ported verbatim.
- **Receiver decodes media itself** (was a WebRTC `<video>` element): **H.264 via
  WebCodecs → `<canvas>`** and **PCM via Web Audio**, with a graceful
  "video unavailable" fallback where WebCodecs is missing. Rebuilt as a Vite +
  React app (was a single Babel-in-browser HTML file).
- **Pairing:** the `<token>:<key>` pairing ID now actually appears in the
  receiver URL fragment, and the receiver splits it (token → relay, key → the
  encryption seam). The token is `SecRandomCopyBytes` hex (no Hypercore pubkey).
- **Events:** the four control events carry over unchanged (`incident_opened`,
  `tier_changed`, `gps_update`, `ai_label`), each with `timestamp_iso`, plus new
  `incident_start`/`incident_closed` and additive enrichments (richer GPS, real
  display name, `trigger` provenance).
- **Encryption** is a deferred, no-op `OutboundTransform`/`InboundTransform` seam
  on the sender and receiver (constructed with the pairing `key`); the relay is
  encryption-agnostic by construction.

---

## Verification status (this checkout)

- **Relay & mock-sender:** pass `node --check`.
- **Receiver:** passes `tsc --noEmit` and `vite build`; the real `translateEvent`
  logic is unit-exercised (event mapping, tier-row dedup, confidence clamp).
- **Sender:** passes a full-module `swiftc -typecheck` against the iOS SDK
  (arm64, iOS 17). It still needs Xcode + a physical device to build and run.
- **Live socket end-to-end was NOT run here** — this environment blocks TCP/UDS
  `listen` (`EPERM`). A cross-component conformance audit verified byte-for-byte
  header and key-for-key event agreement across all four components. **First
  action on a socket-permitting machine:** run Path A above to confirm the live
  flow (fan-out, audio playout, and replay-before-live ordering).
