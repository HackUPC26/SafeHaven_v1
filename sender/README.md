# SafeHaven Sender

Native Swift/SwiftUI iOS app for the protected person. The app is disguised as
a Barcelona weather utility and opens a covert safety session only through
deliberate gestures or codewords.

The sender implements the shared [wire protocol](../PROTOCOL.md) and streams to
the relay over one WebSocket.

## Requirements

- macOS with Xcode 15+
- Swift 5.9 / iOS 17 SDK
- XcodeGen
- Physical iPhone for camera and SoundAnalysis testing

The simulator can run the disguise UI and settings, but camera capture and
SoundAnalysis require a real device.

## Setup

```bash
brew install xcodegen
cd sender
xcodegen generate
open SafeHaven.xcodeproj
```

In Xcode, set your Development Team under Signing & Capabilities, then run on a
device.

## Relay Configuration

The default relay host is read from `App/Info.plist`:

- `SafeHavenRelayHost`
- `SafeHavenRelayUsesTLS`

For local testing, use a LAN-reachable host such as `192.168.1.42:8080` with TLS
off. For production, use the deployed relay host with TLS on.

The hidden Settings screen can override the relay host at runtime.

## Covert Controls

| Gesture | Result |
|---|---|
| Hold the `H:24  L:15` row for 3 seconds | Opens a Tier 1 incident. |
| Type a configured codeword in weather search | Escalates one tier. Defaults: `sunny`, `cloudy`, `stormy`. |
| Long-press `Barcelona` for about 2 seconds | Opens hidden Settings. |

Tier behavior:

- T0: disguise only
- T1: relay socket, audio, GPS, and sound labels
- T2: adds video
- T3: emergency state

## Documentation

- [Implementation notes](IMPLEMENTATION.md)
- [Local development runbook](../docs/LOCAL_DEVELOPMENT.md)
- [Protocol](../PROTOCOL.md)
