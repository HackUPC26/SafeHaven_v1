# SafeHaven v1

SafeHaven is a covert personal-safety stack. A native iPhone sender, disguised
as a weather app, streams a live incident to a trusted contact through a
server-mediated WebSocket relay.

The current v1 architecture is:

```text
iOS sender -> relay WebSocket -> browser receiver
```

No WebRTC, Hypercore, Hyperswarm, or peer-to-peer runtime is used. The shared
wire contract is [PROTOCOL.md](PROTOCOL.md).

## Components

| Component | Location | Purpose |
|---|---|---|
| Sender | [sender/](sender/) | Native Swift/SwiftUI iOS app; captures audio, video, GPS, and on-device sound labels. |
| Relay + receiver | [HackUPC26/Relay-Receiver](https://github.com/HackUPC26/Relay-Receiver) | Standalone Node relay repo. In this workspace it is checked out at `./relay` and includes the Vite receiver app under `relay/receiver`. |
| Mock sender | [tools/mock-sender/](tools/mock-sender/) | Scripted Node sender for local relay/receiver testing before using a phone. |
| Protocol | [PROTOCOL.md](PROTOCOL.md) | Authoritative message, frame, pairing, replay, and encryption-seam contract. |

## Quick Start

### Relay and receiver

```bash
# if ./relay is missing:
git clone https://github.com/HackUPC26/Relay-Receiver.git relay

cd relay
npm install
npm run build
npm start
```

The relay listens on `:8080` by default and serves the built receiver from
`relay/receiver/dist`.

For receiver-only frontend development:

```bash
cd relay
npm ci --prefix receiver
npm run dev:receiver
```

Open the receiver at:

```text
http://localhost:5173/#<token>:<key>
```

### Sender

```bash
cd sender
brew install xcodegen
xcodegen generate
open SafeHaven.xcodeproj
```

Run on a physical iPhone for camera and SoundAnalysis support. Configure the
relay host in `sender/App/Info.plist` or in the app's hidden Settings screen.

### Mock sender

```bash
cd tools/mock-sender
npm install
node mock-sender.js
```

The mock sender prints a receiver URL and drives a scripted incident through the
relay.

## Documentation

- [Local development runbook](docs/LOCAL_DEVELOPMENT.md)
- [Migration from the hackathon prototype](docs/MIGRATION_FROM_HACKATHON.md)
- [Sender README](sender/README.md)
- [Sender implementation notes](sender/IMPLEMENTATION.md)
- [Mock sender README](tools/mock-sender/README.md)
- [Relay-Receiver README](https://github.com/HackUPC26/Relay-Receiver)

## Current Constraints

- The sender is native Swift/SwiftUI; do not reintroduce React Native or Expo.
- The relay is server-mediated WebSocket transport; do not reintroduce WebRTC,
  Hypercore, Hyperswarm, or Bare runtime dependencies.
- ML inference stays on-device.
- The relay is RAM-only and does not store incident data in cloud storage.
