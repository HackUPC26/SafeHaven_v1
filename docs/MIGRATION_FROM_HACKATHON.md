# Migration From The Hackathon Prototype

This document summarizes how SafeHaven v1 differs from the original hackathon
prototype. The README files intentionally stay shorter and link here for the
historical context.

## Architecture

- WebRTC signaling, SDP/ICE, and per-viewer peer connections were replaced with
  one server-mediated WebSocket.
- Hypercore, Hyperswarm, and Bare runtime dependencies were removed.
- The relay is stateful in RAM: it retains the per-session event log and last
  video keyframe, then replays them to late receivers.
- The relay persists nothing to disk and logs no payload contents.

## Sender

- The sender moved from React Native/Expo to native Swift/SwiftUI.
- Video uses VideoToolbox H.264 at 720p.
- Audio is raw PCM from a single AVAudioEngine path.
- GPS uses CoreLocation.
- Sound labels use on-device SoundAnalysis.
- Pairing uses a cryptographically random `<token>:<key>` value generated on
  device.

## Receiver

- The receiver moved from a legacy browser page/WebRTC view to Vite + React.
- Video is decoded through WebCodecs into a canvas.
- Audio is scheduled through Web Audio from raw PCM chunks.
- The receiver reconstructs state from relay-replayed product events, so a late
  joiner sees the incident timeline from the start.
- The receiver source now lives in the standalone Relay-Receiver repo under
  `receiver/`.

## Protocol

- The shared protocol is versioned at `v=1`.
- Text frames carry product events and relay control messages.
- Binary frames use a 16-byte little-endian media header.
- The pairing key is not sent to the relay; it is reserved for the encryption
  transform seam.
- `incident_start` and `incident_closed` were added around the legacy event set.

## Remaining Deferred Work

- End-to-end encryption is still an identity transform seam.
- The consent-gated local incident store exists separately from any future
  hash-chain evidence log.
- App Store hardening and production observability are separate release tasks.
