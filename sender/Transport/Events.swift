//
//  Events.swift
//  SafeHaven — Transport
//
//  Product-event payloads and the JSON text-frame envelope. PROTOCOL §5.
//
//  Every product event is wrapped as:
//      { "type": "event", "payload": { ...event..., "timestamp_iso": "<ISO8601>" } }
//
//  `timestamp_iso` is present on EVERY product event: ISO-8601 UTC, millisecond
//  precision, trailing Z (ISO8601DateFormatter with .withInternetDateTime +
//  .withFractionalSeconds). The relay appends/replays these verbatim and never
//  parses the inner payload (§7).
//

import Foundation

// MARK: - Timestamp formatting

enum EventTime {
    /// ISO-8601 UTC, millisecond precision, trailing Z. PROTOCOL §5.
    /// e.g. "2026-06-01T12:34:56.789Z"
    static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static func nowISO() -> String {
        isoFormatter.string(from: Date())
    }
}

// MARK: - Trigger provenance

/// `trigger` ∈ hold | codeword | ai_auto | manual. PROTOCOL §5.1.
enum EventTrigger: String, Codable {
    case hold
    case codeword
    case aiAuto = "ai_auto"
    case manual
}

// MARK: - Event type discriminator

/// The `event_type` discriminator carried inside each payload. PROTOCOL §5.1.
enum EventType: String, Codable {
    case incidentStart = "incident_start"
    case incidentOpened = "incident_opened"
    case tierChanged = "tier_changed"
    case gpsUpdate = "gps_update"
    case aiLabel = "ai_label"
    case incidentClosed = "incident_closed"
}

// MARK: - Product events
//
// Each event is encoded with stable, snake_case keys matching the wire contract.
// All carry `timestamp_iso`. Optional/null-safe enriched fields are additive so
// older readers ignore unknown keys (PROTOCOL §5.1).

/// `incident_start` — sent first, synchronously with reaching Tier ≥ 1,
/// carrying the configured display name. PROTOCOL §5.2.
struct IncidentStartEvent: Codable {
    let event_type: String
    let person_name: String
    let app_version: String
    let tier: Int
    let trigger: String
    let timestamp_iso: String

    init(personName: String, appVersion: String, tier: Int, trigger: EventTrigger, timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.incidentStart.rawValue
        self.person_name = personName
        self.app_version = appVersion
        self.tier = tier
        self.trigger = trigger.rawValue
        self.timestamp_iso = timestamp
    }
}

/// `incident_opened` — fired ONLY by the 3s hold, ONLY from Tier 0. PROTOCOL §5.1.
struct IncidentOpenedEvent: Codable {
    let event_type: String
    let tier: Int
    let trigger: String
    let timestamp_iso: String

    init(tier: Int, timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.incidentOpened.rawValue
        self.tier = tier
        self.trigger = EventTrigger.hold.rawValue   // HOLD only
        self.timestamp_iso = timestamp
    }
}

/// `tier_changed` — codewords (direct-to-tier) and any other escalation. PROTOCOL §5.1.
struct TierChangedEvent: Codable {
    let event_type: String
    let tier: Int
    let trigger: String
    let timestamp_iso: String

    init(tier: Int, trigger: EventTrigger, timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.tierChanged.rawValue
        self.tier = tier
        self.trigger = trigger.rawValue
        self.timestamp_iso = timestamp
    }
}

/// `gps_update` — base {lat,lng}; enriched fields null-safe. PROTOCOL §5.1.
struct GPSUpdateEvent: Codable {
    let event_type: String
    let lat: Double
    let lng: Double
    let accuracy: Double?
    let speed: Double?
    let heading: Double?
    let altitude: Double?
    let address: String?
    let timestamp_iso: String

    init(lat: Double,
         lng: Double,
         accuracy: Double?,
         speed: Double?,
         heading: Double?,
         altitude: Double?,
         address: String? = nil,
         timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.gpsUpdate.rawValue
        self.lat = lat
        self.lng = lng
        self.accuracy = accuracy
        self.speed = speed
        self.heading = heading
        self.altitude = altitude
        self.address = address
        self.timestamp_iso = timestamp
    }
}

/// `ai_label` — confidence MUST be clamped to [0,1] before sending. PROTOCOL §5.1/§5.3.
struct AILabelEvent: Codable {
    let event_type: String
    let label: String
    let confidence: Double
    let source: String
    let raw_identifier: String
    let timestamp_iso: String

    init(label: String,
         confidence: Double,
         source: String = "SoundAnalysis",
         rawIdentifier: String,
         timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.aiLabel.rawValue
        self.label = label
        // Clamp to [0,1] — defensive even though the classifier clamps too.
        self.confidence = min(1.0, max(0.0, confidence))
        self.source = source
        self.raw_identifier = rawIdentifier
        self.timestamp_iso = timestamp
    }
}

/// `incident_closed` — on explicit stop / de-escalation to Tier 0. PROTOCOL §5.1.
struct IncidentClosedEvent: Codable {
    let event_type: String
    let duration_ms: Int
    let timestamp_iso: String

    init(durationMs: Int, timestamp: String = EventTime.nowISO()) {
        self.event_type = EventType.incidentClosed.rawValue
        self.duration_ms = durationMs
        self.timestamp_iso = timestamp
    }
}

// MARK: - Envelope encoding

enum EventEnvelope {

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        // Keep key order stable-ish and output compact JSON.
        e.outputFormatting = []
        return e
    }()

    /// Cleartext envelope (NO transform). Used for the consent-gated on-device
    /// incident log and any non-wire serialization: the local store keeps the
    /// user's own readable record. The encryption seam (§9) applies only to what
    /// goes on the WIRE — see the `transform:` overload used by RelayClient.
    static func text<E: Encodable>(_ event: E) throws -> String {
        let payloadData = try encoder.encode(event)
        let payloadJSON = String(decoding: payloadData, as: UTF8.self)
        return "{\"type\":\"event\",\"payload\":\(payloadJSON)}"
    }

    /// Wire envelope. The event payload bytes pass through the SAME
    /// `OutboundTransform` as media (§9). Identity today, so the wire is
    /// byte-identical to the cleartext form. When CryptoKit lands, `transformed`
    /// is ciphertext (nonce‖ct‖tag) which is not valid JSON, so the envelope must
    /// then carry it as a base64 string field instead of raw JSON — a localized
    /// change confined here and in the receiver's InboundTransform.
    static func text<E: Encodable>(_ event: E, transform: OutboundTransform) throws -> String {
        let payloadData = try encoder.encode(event)
        // ── SEAM (§9): transform the payload bytes only; envelope stays cleartext. ──
        let transformed = transform.transform(payloadData)
        let payloadJSON = String(decoding: transformed, as: UTF8.self)
        return "{\"type\":\"event\",\"payload\":\(payloadJSON)}"
    }

    /// Optional client→relay announce on (re)connect. PROTOCOL §6.1.
    static func hello() -> String {
        "{\"type\":\"hello\",\"v\":\(RelayConfig.protocolVersion)}"
    }
}

// MARK: - Presence (relay → sender)

/// `{ "type":"presence", "event":"receiver_joined"|"receiver_left", "receivers":<int> }`
/// PROTOCOL §6.2. Relay-generated; the sender decodes these to drive IDR forcing.
struct PresenceMessage: Decodable {
    let type: String
    let event: String
    let receivers: Int

    var isReceiverJoined: Bool { event == "receiver_joined" }
    var isReceiverLeft: Bool { event == "receiver_left" }
}
