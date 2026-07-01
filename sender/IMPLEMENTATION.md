# Sender Implementation Notes

These notes describe the native sender internals. Use the README for setup and
the root protocol for wire-shape authority.

## Project Layout

```text
sender/
  project.yml                 XcodeGen spec
  App/                        app entry, Info.plist, entitlements
  Disguise/                   weather UI, covert trigger, codeword field
  Settings/                   hidden settings, pairing, relay override
  Session/                    tier state machine and subsystem orchestration
  Capture/                    audio, video, location, and media framing
  AI/                         SoundAnalysis label mapping
  Transport/                  WebSocket client, events, frames, transform seam
  Persistence/                consent-gated local incident store
  Config/                     relay host and pairing URL helpers
```

## Runtime Model

- The app starts as a normal weather interface.
- TierController owns the T0-T3 session state.
- Capture starts only when the tier requires it.
- Permissions are requested in context, not at first launch.
- The relay socket opens at Tier 1 and closes when the incident returns to T0.

## Media And Events

- Connect URL: `ws(s)://HOST/ws?role=sender&token=<token>&v=1`.
- The pairing key is never sent to the relay.
- Text frames are `{ "type": "event", "payload": ... }`.
- Binary media frames use the 16-byte little-endian protocol header.
- Video is H.264 Annex-B from VideoToolbox; SPS/PPS are prepended to each IDR.
- Audio is Int16 little-endian mono PCM at 16 kHz in about 20 ms chunks.
- GPS and SoundAnalysis labels are product events.

## Relay Presence

The relay sends sender-only presence frames when receivers join or leave. On
`receiver_joined`, the sender ensures media is active for the current tier and
forces a video keyframe for faster receiver decode.

## Encryption Seam

`Transport/OutboundTransform.swift` is the outbound payload boundary. It is an
identity passthrough today and is constructed with the pairing key so CryptoKit
encryption can be added later without changing relay routing or media framing.

Only payloads are transformed. The binary header and text envelope stay
cleartext because the relay needs them for routing and replay.
