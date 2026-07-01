# Local Development

This runbook covers the full SafeHaven v1 stack in a local checkout where the
standalone RelayServer repo is available at `SafeHaven_v1/relay`.

If `relay/` is missing, create the local checkout first:

```bash
git clone https://github.com/HackUPC26/RelayServer.git relay
```

## Prerequisites

- Node >= 20 for the relay, receiver, and mock sender.
- Xcode 15+, Swift 5.9, XcodeGen, and a physical iPhone for the sender.
- A browser with WebCodecs/H.264 support for live video. Browsers without it
  still show audio, GPS, AI labels, and the event timeline.

## Path A: Relay, Receiver, And Mock Sender

Use this path to exercise the browser receiver without an iPhone.

Terminal 1:

```bash
cd relay
npm install
npm start
```

Terminal 2:

```bash
cd relay
npm ci --prefix receiver
npm run dev:receiver
```

Terminal 3:

```bash
cd tools/mock-sender
npm install
node mock-sender.js
```

The mock sender prints a URL like:

```text
http://localhost:8080/#<token>:<key>
```

For receiver dev mode, open the same fragment on the Vite origin:

```text
http://localhost:5173/#<token>:<key>
```

Expected result: the receiver opens a session, shows tier changes, GPS trail,
AI labels, and playable synthetic PCM audio.

The mock sender emits correctly framed but placeholder H.264 bytes. The browser
decoder may reject them, so a frozen or unavailable video panel is expected in
mock mode. Use the real Swift sender to verify camera video decode.

## Late Join Replay Test

Run the mock sender without `--close`, wait about a minute, then open the
receiver URL in a second tab. The relay should replay the full event log before
live frames continue, so the late tab reconstructs the incident from the start.

## Path B: Full System With iPhone Sender

1. Run the relay on a host reachable from the phone.
2. Build and run the sender on a physical iPhone.
3. Set the relay host in the hidden Settings screen or in `sender/App/Info.plist`.
4. Open the receiver URL from the sender's hidden Settings QR/link.
5. Trigger an incident and verify live H.264 video, PCM audio, GPS, and
   SoundAnalysis labels.

## Sender Trigger Reference

| Action | Gesture | Effect |
|---|---|---|
| Open incident | Press and hold the `H:24  L:15` row for 3 seconds | Opens Tier 1 with `incident_opened`, trigger `hold`. |
| Escalate | Type a codeword in the weather search field | Escalates one tier with trigger `codeword`. Defaults: `sunny`, `cloudy`, `stormy`. |
| Hidden settings | Long-press `Barcelona` for about 2 seconds | Opens display name, codewords, pairing URL, relay host, and consent settings. |

Escalation is monotonic: T0 -> T1 -> T2 -> T3. T1 starts audio, GPS, and sound
classification; T2 adds video; T3 marks emergency state.

## Validation Checklist

- Relay starts on `0.0.0.0:8080`.
- Receiver dev server proxies `/ws` to the relay.
- Mock sender can connect as `role=sender`.
- A receiver can join live and late.
- `npm run build` in `relay/` produces `receiver/dist` for production serving.
- Sender on a device can connect to the configured relay host.
