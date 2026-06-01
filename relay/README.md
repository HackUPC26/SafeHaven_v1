# SafeHaven v1 Relay (M1)

A tiny **stateful** WebSocket relay. One WebSocket per participant, keyed by a
session **token**. It fans out a single sender's frames to all receivers and —
because the spec deliberately overrides "stateless dumb pipe" (§0/§7 of
[`../PROTOCOL.md`](../PROTOCOL.md)) — it retains the **full per-session event
log** plus the **last video keyframe** in RAM and replays them to any receiver
that joins mid-incident, so a contact opening the link late sees the **entire
timeline from the start**.

> `../PROTOCOL.md` is the authoritative spec. Where this README and the spec
> disagree, the spec wins. Section refs (§N) below point at it.

## What it does

- `http.createServer` + `WebSocketServer({ server })` on one port.
- Connect URL: `ws[s]://HOST/ws?role=<sender|receiver>&token=<urlencoded>&v=1`.
- **Validation / close codes (§1.3 / §10):**
  - invalid `role` → `4000`
  - missing `token` → `4001`
  - second live sender on a token → `4002`
  - version mismatch → `4003` *(only when `STRICT_VERSION=1`; see below)*
- **Per-token `RoomState` (§7):** `{ sender, receivers, eventLog, lastVideoIDR }`.
  - Every **TEXT** frame with top-level `type:"event"` is appended **verbatim**
    to `eventLog` in arrival order.
  - The last **BINARY** frame whose 16-byte header has the **KEYFRAME flag**
    (byte 2, bit 0) is retained as `lastVideoIDR`. Audio + delta video are never
    retained.
  - A fresh `incident_start` **clears** the log (new session boundary).
- **Fan-out:** sender TEXT + BINARY → all receivers, verbatim.
- **Join replay (§7/§8):** on a receiver join the relay sends that receiver the
  **entire `eventLog` in order, then `lastVideoIDR`, before any live frame**.
  Live frames arriving during replay are **buffered per-connection** and flushed
  in order once replay completes — history never interleaves with live.
- **Presence (§6.2):** receiver join/leave → `{type:"presence", event, receivers}`
  to the **sender only**, with the current count. The sender uses
  `receiver_joined` to ensure it's encoding for the tier and to force an IDR.
- **Room teardown (§7):** when `!sender && receivers.size === 0` the room (and
  its whole log) is dropped.

## What it deliberately does NOT do

- **No payload reading (§7/§9).** It reads only: WS frame **type** (text vs
  binary), the **top-level `type`** of text frames (to know a frame is a product
  "event" worth logging), and the binary **KEYFRAME flag**. It never parses the
  inner `payload` / `event_type`. *(One narrow exception, fully documented in
  `relay.js`: detecting `incident_start` to clear the session log requires
  reading the single field `payload.event_type`. This is the minimal peek the
  stateful-replay design requires; it is never logged.)*
- **No disk. No payload logging.** RAM only; connection metadata only, token-
  prefixed. The legacy no-role "bridge" branch that logged message bodies is gone.
- **No WebRTC.** No SDP/ICE/offer/answer/per-viewer peer connections. The only
  relay→sender control is `presence`.
- **No transform.** The encryption seam (§9) lives on the sender/receiver; the
  relay forwards opaque bytes and never changes when encryption lands.

## Stale-sender detection (why a reconnect isn't wrongly 4002'd)

A hard network drop can leave a sender socket lingering without a clean close,
which would make a legitimate reconnect look like a "second sender" (`4002`).
To avoid that the relay runs a **ws-level ping/pong heartbeat** every 30 s: each
socket is marked dead if it misses a pong, and a dead **sender** is `terminate()`d
so the token frees up. Additionally, the moment a new sender connects we proactively
reclaim the existing sender if its socket is closed/not-OPEN or already flagged
dead by the heartbeat. Net effect: dupes are still rejected, but a real reconnect
after a drop is accepted.

## Static hosting (production vs dev)

- **Production:** if `../receiver/dist` exists, the same port serves the built
  receiver SPA (with an `index.html` SPA fallback so deep links and the
  `#<token>:<key>` fragment work). Build it with `vite build` in the receiver.
- **Dev:** if `dist/` is **absent**, the relay serves **404** for static assets
  and logs a one-time hint. Run the **Vite dev server** for the UI and point it
  at this relay's `/ws`.

## Run

```bash
cd relay
npm install
# optional: cp .env.example .env  (PORT, MAX_EVENT_LOG)
npm start
# strict version rejection instead of warn-and-allow:
STRICT_VERSION=1 npm start
# custom port:
PORT=9000 npm start
```

Requires **Node ≥ 20**, ESM (`"type":"module"`), dependency: `ws`.

## Config (`.env.example`)

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP + WS listen port |
| `MAX_EVENT_LOG` | `10000` | Per-session event-log safety cap (§7/§11). On overflow, oldest events drop and a **non-silent** truncation line is logged. |
| `STRICT_VERSION` | unset | `1` → close `4003` on `v != 1`; default is tolerate-and-warn (§10). |

## Versioning note (§10)

The spec allows either closing `4003` on a version mismatch **or** tolerate-and-
warn. The default here is **warn-and-allow** (spec default); set `STRICT_VERSION=1`
to hard-close `4003`. A missing `v` is also tolerated with a warning.

## Quick local smoke test

1. `npm start` in `relay/`.
2. In another shell, run the mock sender (`../tools/mock-sender`) — it prints a
   receiver URL.
3. Open that URL in the receiver (Vite dev server in dev) and watch the incident
   populate, including the full back-timeline if you join late.
