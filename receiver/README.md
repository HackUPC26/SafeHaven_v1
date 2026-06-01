# SafeHaven v1 — Receiver

The contact-facing dashboard. A **Vite + React + TypeScript** app, served by the
relay, that a worried contact opens from the pairing link — **no install** — to
watch a protected person's live session over the single relay WebSocket.

This is the M2 receiver. It implements `../PROTOCOL.md` (the ratified spec). If
anything here disagrees with `PROTOCOL.md`, **PROTOCOL.md wins.**

## Run

```bash
npm install
npm run dev        # http://localhost:5173  (proxies /ws -> ws://localhost:8080)
```

Open with a pairing fragment:

```
http://localhost:5173/#<token>:<key>
```

`token` and `key` are each 32 hex chars (PROTOCOL §1.1). The receiver splits on
the **first** `:` — `token` is sent to the relay; `key` is retained for the
deferred encryption seam (`src/transport/inboundTransform.ts`). With no
fragment, the **TokenEntry** overlay prompts for the pairing string.

In dev, the Vite server proxies the same-origin `/ws` path to the local relay on
`ws://localhost:8080`, so the browser talks to one origin exactly as in prod
(where the relay also serves this bundle).

```bash
npm run typecheck  # tsc --noEmit
npm run build      # type-check + production bundle into dist/
npm run preview    # serve the built bundle
```

## Architecture

```
src/
  main.tsx                  Vite entry (SW intentionally NOT registered)
  App.tsx                   Wires transport + media + incident state -> UI
  styles.css                Global styles + keyframes (ported from legacy)

  transport/
    socket.ts               WS lifecycle: connect, reconnect backoff, demux,
                            close-code handling (4000/4002/4003 terminal)
    frame.ts                16-byte LE binary media header parser (DataView)
    pairing.ts              #<token>:<key> fragment parsing (split on first ':')
    inboundTransform.ts     ENCRYPTION SEAM (§9) — identity passthrough today

  media/
    videoDecoder.ts         WebCodecs H.264 Annex-B -> <canvas>; staleness;
                            graceful "video unavailable" fallback (§4.3)
    audioPlayer.ts          PCM Int16 -> Float32 gapless Web Audio scheduling
    audioLevels.ts          44-bar meter from decoded PCM

  events/
    translateEvent.ts       wire product events -> internal entries
    incidentState.ts        useIncidentState reducer (session/tier/gps/trail/…)
    labelMap.ts             AI_LABEL_MAP (+SPEECH_NORMAL) + ALERT_AUDIO_LABELS
    theme.ts                palette + typeColor + DOT_COLOR

  components/               SessionHeader, RiskBanner, Tabs, VideoFeed,
                            AudioPanel, GPSMap, Pill, IncidentLog, Footer,
                            TokenEntry, WaitingScreen
```

## Notes vs. the legacy receiver

- Transport is a **single relay WebSocket**, not WebRTC/Hypercore. The Map tab's
  signal pill now reads **RELAY** (was the misleading **P2P**).
- Video is a **`<canvas>`** fed by WebCodecs (was a `<video>` MediaStream).
- The GPS map projects **real lat/lng relative to the first fix** and draws a
  **movement trail** — fully self-contained SVG, **no external map tiles** (a
  privacy decision: a contact's view never phones a tile server).
- Events read the **real `trigger`** (incl. `hold`) and the **enriched GPS**
  fields; sessions open from a **real `incident_start`** name (with the
  defensive synthesize-on-first-signal fallback retained, §5.2).
