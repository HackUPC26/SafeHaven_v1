//
//  TierController.swift
//  SafeHaven — Session
//
//  The T0–T3 tier state machine. This is the Swift port of App.js's tier logic,
//  centralised into one type and wired to the native subsystems.
//
//  Tier model (App.js header + PROTOCOL §0/§4.1):
//    T0 idle
//    T1 audio + GPS + on-device classification (RelayClient opens here)
//    T2 + video
//    T3 emergency
//
//  Trigger rules:
//    - HOLD (3s on the H/L row): from T0 only, escalate to T1 and emit
//      incident_opened{tier:1, trigger:"hold"}. (App.js sos handler.)
//    - CODEWORD (every keystroke, lowercased+trimmed): monotonic +1 only:
//      sunny@0->1, cloudy@1->2, stormy@2->3, emitting tier_changed{trigger:"codeword"}.
//    - On the FIRST escalation reaching Tier ≥ 1, emit incident_start with the
//      configured display name (PROTOCOL §5.2) BEFORE the triggering event, so
//      the relay's session log opens with the header.
//    - On de-escalation/stop back to T0, emit incident_closed{duration_ms} and
//      tear down all capture (PROTOCOL §5.1).
//
//  Subsystem gating per tier:
//    T1: open socket, incident_start (first), start audio engine + classifier,
//        start GPS.
//    T2: start video encode/stream.
//    T3: emergency (video already running; no new media subsystem, just tier).
//
//  Buffer-before-open (§8) is handled by RelayClient: incident_start and the
//  triggering event are queued the instant they fire (synchronously with the
//  state change) and flushed when the socket opens.
//

import Foundation

@MainActor
final class TierController: ObservableObject {

    /// Current tier (0…3). Drives the disguise status dot.
    @Published private(set) var tier: Int = 0

    private let settings: SettingsStore
    private let consent: Consent
    private let relay: RelayClient
    private let capture = CaptureCoordinator()
    private let location = LocationProvider()
    private let incidentStore: IncidentStore

    /// When the incident opened (first reach Tier ≥ 1), for duration_ms.
    private var incidentStartedAt: Date?
    /// Per-kind monotonic sequence numbers; reset on sender reconnect (§3/§8).
    private var videoSeq: UInt32 = 0
    private var audioSeq: UInt32 = 0

    private let appVersion: String

    init(settings: SettingsStore, consent: Consent) {
        self.settings = settings
        self.consent = consent
        self.incidentStore = IncidentStore(consent: consent)
        self.relay = RelayClient(pairingKey: settings.pairingKey)
        self.appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "1.0"

        capture.delegate = self
        location.delegate = self
        relay.delegate = self
    }

    // MARK: - Triggers (from the disguise UI)

    /// 3s hold on the H/L row. From T0 ONLY: escalate to T1 and emit
    /// incident_opened{tier:1, trigger:"hold"}. PROTOCOL §5.1. (App.js sos.)
    func handleHold() {
        guard tier == 0 else { return }   // HOLD only fires from Tier 0
        openIncidentIfNeeded(initialTier: 1, trigger: .hold)
        applyTier(1)
        relay.sendEvent(IncidentOpenedEvent(tier: 1))
        emitToLocalLogIfConsented(IncidentOpenedEvent(tier: 1))
    }

    /// Codeword check on every keystroke. Lowercased + trimmed; monotonic +1
    /// only. Mirrors App.js checkCodeword exactly. PROTOCOL §5.1.
    func handleCodewordInput(_ text: String) {
        let word = text.lowercased().trimmingCharacters(in: .whitespaces)
        let cw = settings.codewords

        if word == cw.tier1, tier == 0 {
            openIncidentIfNeeded(initialTier: 1, trigger: .codeword)
            applyTier(1)
            relay.sendEvent(TierChangedEvent(tier: 1, trigger: .codeword))
            emitToLocalLogIfConsented(TierChangedEvent(tier: 1, trigger: .codeword))
        } else if word == cw.tier2, tier == 1 {
            applyTier(2)
            relay.sendEvent(TierChangedEvent(tier: 2, trigger: .codeword))
            emitToLocalLogIfConsented(TierChangedEvent(tier: 2, trigger: .codeword))
        } else if word == cw.tier3, tier == 2 {
            applyTier(3)
            relay.sendEvent(TierChangedEvent(tier: 3, trigger: .codeword))
            emitToLocalLogIfConsented(TierChangedEvent(tier: 3, trigger: .codeword))
        }
    }

    /// Explicit stop / de-escalation to Tier 0 (e.g. from a future manual
    /// control). Emits incident_closed{duration_ms} and tears down. PROTOCOL §5.1.
    func stopIncident() {
        guard tier > 0 else { return }
        let durationMs = incidentStartedAt.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
        let closed = IncidentClosedEvent(durationMs: durationMs)
        relay.sendEvent(closed)
        emitToLocalLogIfConsented(closed)
        applyTier(0)
    }

    // MARK: - Incident opening

    /// On the FIRST escalation to Tier ≥ 1, emit incident_start (with the real
    /// display name) BEFORE the triggering event, so the relay's log header is
    /// first. PROTOCOL §5.2. Idempotent within a session.
    private func openIncidentIfNeeded(initialTier: Int, trigger: EventTrigger) {
        guard incidentStartedAt == nil else { return }
        incidentStartedAt = Date()

        // Open the socket the instant we reach Tier ≥ 1 (§8). Idempotent start
        // keyed by token: re-entry never opens a 2nd socket.
        relay.start(token: settings.token)

        let name = settings.displayName.isEmpty ? "SafeHaven" : settings.displayName
        let start = IncidentStartEvent(personName: name,
                                       appVersion: appVersion,
                                       tier: initialTier,
                                       trigger: trigger)
        relay.sendEvent(start)
        emitToLocalLogIfConsented(start)
    }

    // MARK: - Tier application (subsystem gating)

    /// Apply a new tier and start/stop subsystems accordingly. Centralises the
    /// scattered App.js useEffects ([tier], [tier>=1], pairingId) into one place.
    private func applyTier(_ newTier: Int) {
        let previous = tier
        guard newTier != previous else { return }
        tier = newTier

        if newTier == 0 {
            // De-escalation / stop → tear everything down.
            location.stop()
            capture.stopAll()
            relay.stop()
            incidentStartedAt = nil
            videoSeq = 0
            audioSeq = 0
            return
        }

        // Tier ≥ 1: audio engine (classifier + PCM) + GPS.
        if newTier >= 1 {
            capture.startAudio()
            location.start()
        }

        // Tier ≥ 2: video encode/stream (PROTOCOL §4.1).
        if newTier >= 2 {
            capture.startVideo()
        } else {
            capture.stopVideo()
        }
        // Tier 3 (emergency) adds no new media subsystem beyond T2's video; the
        // distinction is carried in the tier_changed event for the receiver.
    }

    // MARK: - Local incident log (consent-gated)

    private func emitToLocalLogIfConsented<E: Encodable>(_ event: E) {
        guard consent.incidentLogEnabled else { return }
        if let json = try? EventEnvelope.text(event) {
            incidentStore.append(envelopeJSON: json)
        }
    }
}

// MARK: - Media + AI → transport

extension TierController: CaptureCoordinatorDelegate {

    func captureCoordinator(_ c: CaptureCoordinator,
                            didEncodeVideo annexB: Data,
                            isKeyframe: Bool,
                            ptsMicros: UInt64) {
        // IDR: KEYFRAME flag + retain-last-of-kind; delta: none. PROTOCOL §3/§4.1.
        let flags: FrameFlags = isKeyframe ? [.keyframe] : []
        let cacheClass: CacheClass = isKeyframe ? .retainLastOfKind : .none
        relay.sendMedia(kind: .video,
                        flags: flags,
                        cacheClass: cacheClass,
                        seq: videoSeq,
                        ptsMicros: ptsMicros,
                        payload: annexB)
        videoSeq &+= 1
    }

    func captureCoordinator(_ c: CaptureCoordinator,
                            didProduceAudio data: Data,
                            ptsMicros: UInt64) {
        // PCM: kind=2, no keyframe, cacheClass=none. PROTOCOL §3/§4.2.
        relay.sendMedia(kind: .audio,
                        flags: [],
                        cacheClass: .none,
                        seq: audioSeq,
                        ptsMicros: ptsMicros,
                        payload: data)
        audioSeq &+= 1
    }

    func captureCoordinator(_ c: CaptureCoordinator,
                            didEmitAILabel label: String,
                            confidence: Double,
                            rawIdentifier: String) {
        // confidence is clamped in the classifier; AILabelEvent re-clamps too.
        let event = AILabelEvent(label: label,
                                 confidence: confidence,
                                 rawIdentifier: rawIdentifier)
        relay.sendEvent(event)
        emitToLocalLogIfConsented(event)
    }
}

// MARK: - GPS → transport

extension TierController: LocationProviderDelegate {
    func locationProvider(_ provider: LocationProvider, didUpdate event: GPSUpdateEvent) {
        relay.sendEvent(event)
        emitToLocalLogIfConsented(event)
    }
}

// MARK: - Relay presence + reconnect

extension TierController: RelayClientDelegate {

    func relayClientReceiverJoined(_ client: RelayClient, receivers: Int) {
        // Ensure we're encoding for the current tier and force an IDR so the new
        // viewer resyncs fast. PROTOCOL §6.2.
        if tier >= 2 {
            if !capture.isVideoRunning { capture.startVideo() }
            capture.forceVideoKeyframe()
        }
    }

    func relayClientReceiverLeft(_ client: RelayClient, receivers: Int) {
        // No teardown on last receiver leaving — the sender keeps streaming so a
        // re-joiner resyncs from the relay's cached IDR + event log.
    }

    func relayClientDidOpen(_ client: RelayClient, isReconnect: Bool) {
        // seq is per-kind monotonic for the life of one sender connection and
        // RESETS on sender reconnect (PROTOCOL §3/§8). Reset here and force an
        // IDR so the receiver re-arms "await keyframe".
        if isReconnect {
            videoSeq = 0
            audioSeq = 0
            if tier >= 2 { capture.forceVideoKeyframe() }
        }
    }
}
