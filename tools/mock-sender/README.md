# SafeHaven mock sender

A Node test tool that connects to the [relay](../../relay) as `role=sender` and
drives a **scripted incident** end-to-end, so the receiver dashboard can be
exercised before the native Swift sender exists. A human runs the relay, runs
this, opens the printed receiver URL, and watches a full incident populate.

> Authoritative spec: [`../../PROTOCOL.md`](../../PROTOCOL.md). Section refs
> (§N) point at it.

## What it emits

- A crypto-random `pairingId = <token>:<key>` (32 hex chars each, §1.1) and the
  receiver URL `http://HOST/#<token>:<key>` (§1.2). The **key is never sent to
  the relay** — it lives only in the URL fragment (encryption seam §9, unused
  today).
- Connects `ws://HOST/ws?role=sender&token=...&v=1` (§1.3) with
  buffer-before-open + auto-reconnect backoff (2000 ms ×1.5 cap 30000 ms, reset
  on open; per-kind `seq` resets on reconnect) (§8).
- A scripted timeline of product events (§5), each with `timestamp_iso` (ISO-8601
  UTC ms `Z`):
  - `incident_start` (with `person_name`) + `incident_opened` (HOLD, Tier 1),
  - moving `gps_update`s around Barcelona (~41.3874, 2.1686) with
    accuracy/speed/heading/altitude so the trail is visible,
  - `tier_changed` escalations (codeword, direct-to-tier) up to `--max-tier`,
  - `ai_label`s cycling the 8 protocol labels (§5.3) with clamped
    confidences,
  - optional `incident_closed` (with `--close`).
- **Real** BINARY audio: synthesized sine-wave **PCM Int16, 16 kHz, mono, 20 ms
  chunks (640 B)**, `kind=AUDIO_PCM`, `cacheClass=none`, correct 16-byte LE
  header (§3/§4.2). The receiver can actually play this.
- BINARY video frames with a **correct 16-byte header** (`kind=VIDEO_H264`,
  `KEYFRAME` flag + `cacheClass=retain-last-of-kind` every 2 s, monotonic `seq`,
  `ptsMicros`) wrapping an **Annex-B-*shaped* placeholder payload**.

### Video limitation (read this)

Hand-rolling a genuinely decodable H.264 bitstream in pure Node is out of scope,
so the video **payload** is a placeholder (start-code-prefixed placeholder NAL
bytes), **not** real H.264. This fully exercises the receiver's **framing** path
(frame-type routing, header parse, await-keyframe gating, `seq` loss/restart
detection, relay IDR caching + late-join replay) and the decode-error / "FEED
FROZEN" fallback (§4.3), but the receiver's **WebCodecs decode will reject these
frames**. To verify the real decode path, drive the receiver with the Swift
sender (VideoToolbox → Annex-B), or extend this tool to stream a pre-encoded
`.h264` Annex-B file. Audio is real and plays. Use `--no-video` to test the
audio-only / WebCodecs-absent path cleanly.

## Run

```bash
cd tools/mock-sender
npm install
node mock-sender.js                      # relay at localhost:8080, full incident, stays live
node mock-sender.js --pace=2             # 2× slower (easier to watch)
node mock-sender.js --no-video           # audio + events only
node mock-sender.js --host=localhost:9000 --name="Alex" --max-tier=2
node mock-sender.js --close              # escalate then incident_closed and exit
```

Requires **Node ≥ 20**, dependency: `ws`.

### Flags

| Flag | Default | Meaning |
|---|---|---|
| `--host=HOST:PORT` | `localhost:8080` | Relay host (bare host:port or full `ws(s)://` URL). |
| `--pace=N` | `1` | Time multiplier. `N>1` slower, `N<1` faster. |
| `--video` / `--no-video` | video on | Include/exclude BINARY video. |
| `--name=NAME` | `Maria` | `person_name` in `incident_start`. |
| `--max-tier=T` | `3` | Highest tier to escalate to (1–3). |
| `--close` | off | Emit `incident_closed` and exit after escalating. |

## Testing late-join replay

1. Start the relay, then `node mock-sender.js` (leave it streaming, no `--close`).
2. Open the receiver URL — watch tier/GPS/AI/audio populate live.
3. Open the **same URL in a second tab a minute later**: the relay replays the
   **full event log in order, then the last video IDR**, so the new tab
   reconstructs the entire timeline (the whole GPS trail, every tier change and
   AI label) before live frames resume (§7/§8).

## Encryption seam (§9)

The tool constructs an identity `OutboundTransform` with the pairing `key`
(plumbed now, unused today). The single comment-marked boundary in
`mock-sender.js` is where CryptoKit `seal` would slot in later — it transforms
only payloads; headers/envelopes stay cleartext, so the relay never changes.
