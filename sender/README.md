# SafeHaven v1 — Sender (native Swift / SwiftUI, iOS 17)

The **sender** half of SafeHaven: a covert personal-safety app disguised as a
Barcelona weather utility. It streams over the relay WebSocket per
[`../PROTOCOL.md`](../PROTOCOL.md) (the authoritative spec) — H.264 video, raw
PCM audio, GPS, and on-device SoundAnalysis labels — escalating through a
four-tier state machine triggered by a covert 3-second hold and spoken
codewords. There is **no visible safety UI** beyond a subtle status dot.

This is a clean, native rewrite of the legacy React Native / Expo app
(`SafeHaven/mobile`). No third-party dependencies; everything is Apple-platform
native (AVFoundation, VideoToolbox, SoundAnalysis, CoreLocation, Security,
CryptoKit, URLSession).

---

## Generate & run

This repo ships an [XcodeGen](https://github.com/yonaskolb/XcodeGen) `project.yml`
instead of a checked-in `.xcodeproj`, so the project file regenerates cleanly.

```sh
brew install xcodegen      # one-time
cd sender
xcodegen generate          # produces SafeHaven.xcodeproj
open SafeHaven.xcodeproj
```

Then in Xcode set your **Development Team** (Signing & Capabilities) and run.

### Physical device required

The camera and on-device SoundAnalysis (`SNClassifySoundRequest(.version1)`) are
**unavailable in the iOS Simulator**. To exercise capture/classification you must
run on a **physical iPhone**. The disguise UI, settings, pairing QR, and the tier
state machine work in the simulator; media capture silently no-ops there.

---

## Relay host configuration

The relay host is read from the `SafeHavenRelayHost` key in `App/Info.plist`
(replacing the legacy `EXPO_PUBLIC_SIGNAL_HOST` env var), with an in-app override
in the hidden Settings screen.

- **Production:** set `SafeHavenRelayHost` to your relay host and
  `SafeHavenRelayUsesTLS` to `true` → connects over `wss://`.
- **Local dev:** default is `localhost:8080` with TLS off → connects over
  `ws://localhost:8080/ws?...`. To test against a relay on your LAN, set the
  host override in Settings (e.g. `192.168.1.42:8080`).

### App Transport Security (ATS)

`App/Info.plist` keeps ATS **on** (`NSAllowsArbitraryLoads = false`) but enables
`NSAllowsLocalNetworking = true`, which permits cleartext `ws://` to
`localhost`/LAN for development **without** weakening TLS for production `wss://`.
No global ATS exception is needed.

---

## Opening the hidden surfaces (covert gestures)

The app looks and behaves like an ordinary weather app. The safety surfaces are
reachable only by deliberate gestures:

| Gesture | Action |
|---|---|
| **3s hold** on the `H:24°  L:15°` row | SOS trigger → Tier 1 (`incident_opened`, `trigger:"hold"`). A green dot flashes for 1.2s. |
| Type a **codeword** in the `Search weather…` field | Escalate one tier (`tier_changed`, `trigger:"codeword"`). Monotonic only: tier-1 word → T1, tier-2 word → T2, tier-3 word → T3. |
| **2s long-press** on `Barcelona` | Open the hidden Settings sheet. |

Default codewords are `sunny` / `cloudy` / `stormy` (change them in Settings).

---

## Tiers (PROTOCOL §0 / §4–§5)

| Tier | What runs |
|---|---|
| **0** Idle | Nothing. No socket, no capture, no status dot. |
| **1** | Relay socket opens; `incident_start` (with display name) → audio engine (SoundAnalysis + 16 kHz PCM stream) + GPS. Orange dot. |
| **2** | + H.264 720p ~2 Mbps video (front camera). Orange dot. |
| **3** Emergency | Same media as T2; the tier change is signalled to the receiver. Red dot. |

De-escalation/stop to Tier 0 emits `incident_closed{duration_ms}` and tears down
all capture and the socket.

**Permissions are requested in-context** on escalation (mic at T1, camera at T2,
location at T1) — never at first launch, to preserve the disguise.

---

## Project layout

```
sender/
  project.yml                 XcodeGen spec (bundle id, iOS 17, frameworks, bg modes)
  App/
    SafeHavenApp.swift         @main; owns state objects; presents WeatherView only
    Info.plist                 usage strings, background modes, ATS, relay host key
    SafeHaven.entitlements     Keychain access group
  Disguise/
    WeatherView.swift          Barcelona weather disguise (verbatim content)
    HoldToTrigger.swift        3s hold primitive (fill transparent→white .15, 200ms cancel)
    CodewordField.swift        "Search weather…" field; per-keystroke forwarding
    StatusDot.swift            subtle orange/red dot, tier > 0 only
  Settings/
    SettingsView.swift         hidden settings: name, codewords, pairing QR, relay, reset, consent
    SettingsStore.swift        Keychain token/key/pairingId (SecRandomCopyBytes); UserDefaults name/codewords
  Session/
    TierController.swift        T0–T3 machine; triggers, escalation, subsystem gating, event wiring
  Capture/
    CaptureCoordinator.swift    ONE AVCaptureSession + ONE AVAudioEngine; fans mic to classifier + streamer
    VideoEncoder.swift          VTCompressionSession H.264 Baseline; AVCC→Annex-B; SPS/PPS per IDR
    AudioStreamer.swift         AVAudioConverter → 16 kHz Int16 mono → 20 ms chunks
    LocationProvider.swift      CLLocationManager; enriched gps_update; background updates
  AI/
    SoundClassifier.swift       VERBATIM port of SafeHavenAIModule.swift (mapping/constants/semantics)
  Transport/
    RelayClient.swift           URLSessionWebSocketTask; reconnect backoff; buffer/flush; presence; ping
    Frame.swift                 16-byte little-endian binary media header
    Events.swift                Codable product events + envelope + ISO8601 timestamp_iso
    OutboundTransform.swift     ENCRYPTION SEAM (identity passthrough today; CryptoKit later)
  Persistence/
    IncidentStore.swift         consent-gated on-device append log (hash-chain deferred)
    Consent.swift               explicit consent flag (default OFF)
  Config/
    RelayConfig.swift           host from Info.plist + in-app override; builds ws(s) connect URL
```

---

## Wire conformance notes

- **Connect URL:** `ws(s)://HOST/ws?role=sender&token=<urlencoded>&v=1` (§1.3).
  The `key` half of the pairing ID is **never** sent to the relay; it lives only
  in the receiver URL fragment and is handed to the local `OutboundTransform`.
- **Binary header:** 16-byte little-endian — version, kind, flags, cacheClass,
  u32 seq, u64 ptsMicros (§3). Built in `Frame.swift`.
- **Video:** H.264 Annex-B; SPS+PPS prepended to **every IDR**; IDR carries
  `flags.KEYFRAME` + `cacheClass = retain-last-of-kind`; deltas `cacheClass = none`
  (§4.1). Forced IDR every 2s, on receiver join (§6.2), and on reconnect.
- **Audio:** Int16 LE mono 16 kHz, 320-sample (640-byte) ~20 ms chunks,
  `kind = AUDIO_PCM`, `cacheClass = none` (§4.2).
- **Events:** `{ "type":"event", "payload": { …, "timestamp_iso":"…Z" } }` with
  ISO-8601 UTC millisecond precision (§5). `confidence` clamped to `[0,1]`.
  `incident_start` is sent first on reaching Tier ≥ 1 (§5.2).
- **seq** is per-kind monotonic and **resets on sender reconnect** (§3/§8);
  reconnect forces an IDR so the receiver re-arms "await keyframe".
- **Buffer-before-open / flush-on-open** in order (§8): the first Tier-1 events
  fire synchronously with the state change and are flushed when the socket opens.
- **Idempotent start** keyed by token: re-entering an active tier never opens a
  second socket (§8).

## Encryption seam (deferred — design only, §9)

`Transport/OutboundTransform.swift` is the single boundary every outbound payload
passes through. It is an **identity passthrough today**, constructed with the
pairing `key` (plumbed from Keychain) so CryptoKit `seal` can drop in later
without touching the relay or the framing. Only **payloads** are transformed; the
binary header and the `{type:"event",payload}` envelope stay cleartext. The seam
is marked with a clear comment in that file and in `RelayClient.sendMedia`.
