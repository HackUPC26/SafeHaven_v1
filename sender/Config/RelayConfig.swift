//
//  RelayConfig.swift
//  SafeHaven — Config
//
//  Resolves the relay host and builds the WebSocket connect URL per PROTOCOL §1.3:
//
//      <ws|wss>://HOST/ws?role=<sender|receiver>&token=<urlencoded>&v=1
//
//  The host comes from the Info.plist key `SafeHavenRelayHost` (replacing the
//  legacy EXPO_PUBLIC_SIGNAL_HOST env var) and may be overridden in the hidden
//  Settings screen at runtime. Production uses wss://; local dev may use ws://
//  against localhost/LAN (permitted by NSAllowsLocalNetworking in ATS).
//

import Foundation

enum RelayConfig {

    /// Protocol version carried in the connect query (`v=1`) — PROTOCOL §10.
    static let protocolVersion = 1

    /// `role=sender` — this app is always the sender. PROTOCOL §1.3.
    static let role = "sender"

    /// UserDefaults key for the in-app host override set from Settings.
    private static let hostOverrideKey = "safehaven.relay.hostOverride"
    /// UserDefaults key for the in-app "uses TLS" override.
    private static let tlsOverrideKey = "safehaven.relay.usesTLSOverride"

    // MARK: - Host resolution

    /// The effective relay host (e.g. `relay.example.com` or `localhost:8080`).
    /// In-app Settings override wins; otherwise the Info.plist default is used.
    static var host: String {
        if let override = UserDefaults.standard.string(forKey: hostOverrideKey),
           !override.trimmingCharacters(in: .whitespaces).isEmpty {
            return override.trimmingCharacters(in: .whitespaces)
        }
        if let plistHost = Bundle.main.object(forInfoDictionaryKey: "SafeHavenRelayHost") as? String,
           !plistHost.isEmpty {
            return plistHost
        }
        return "localhost:8080"
    }

    /// Whether to use TLS (wss). Settings override wins; otherwise Info.plist.
    static var usesTLS: Bool {
        if UserDefaults.standard.object(forKey: tlsOverrideKey) != nil {
            return UserDefaults.standard.bool(forKey: tlsOverrideKey)
        }
        if let plistTLS = Bundle.main.object(forInfoDictionaryKey: "SafeHavenRelayUsesTLS") as? Bool {
            return plistTLS
        }
        return false
    }

    // MARK: - Overrides (Settings)

    /// Persist an in-app host override (nil/empty clears it, reverting to plist).
    static func setHostOverride(_ value: String?) {
        let defaults = UserDefaults.standard
        if let value, !value.trimmingCharacters(in: .whitespaces).isEmpty {
            defaults.set(value.trimmingCharacters(in: .whitespaces), forKey: hostOverrideKey)
        } else {
            defaults.removeObject(forKey: hostOverrideKey)
        }
    }

    /// Persist an in-app TLS override (nil clears it, reverting to plist).
    static func setTLSOverride(_ value: Bool?) {
        let defaults = UserDefaults.standard
        if let value {
            defaults.set(value, forKey: tlsOverrideKey)
        } else {
            defaults.removeObject(forKey: tlsOverrideKey)
        }
    }

    // MARK: - URLs

    /// `http(s)://HOST` — base used to render the receiver pairing URL.
    /// PROTOCOL §1.2: `https://<relay-host>/#<token>:<key>`.
    static var httpBase: String {
        "\(usesTLS ? "https" : "http")://\(host)"
    }

    /// `ws(s)://HOST` — base for the WebSocket connect URL.
    static var wsBase: String {
        "\(usesTLS ? "wss" : "ws")://\(host)"
    }

    /// The receiver pairing URL shown as a QR code + selectable link in Settings.
    /// The full `<token>:<key>` lives in the URL fragment; the receiver splits on
    /// the first ':' (PROTOCOL §1.2). The key is never sent to the relay.
    static func pairingURL(pairingId: String) -> String {
        "\(httpBase)/#\(pairingId)"
    }

    /// The sender WebSocket connect URL for a given token. PROTOCOL §1.3.
    /// The token is URL-encoded; the key is NEVER placed on the wire.
    static func senderWebSocketURL(token: String) -> URL? {
        var components = URLComponents(string: "\(wsBase)/ws")
        components?.queryItems = [
            URLQueryItem(name: "role", value: role),
            URLQueryItem(name: "token", value: token),
            URLQueryItem(name: "v", value: String(protocolVersion)),
        ]
        return components?.url
    }
}
