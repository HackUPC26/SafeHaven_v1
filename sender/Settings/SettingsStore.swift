//
//  SettingsStore.swift
//  SafeHaven — Settings
//
//  Persists the sender's identity and configuration. Port of the legacy
//  services/settings.js with the storage backends upgraded:
//
//   - token + key + pairingId  → Keychain (SecItem). PROTOCOL §1.1 requires the
//     token and key to each be 32 hex chars from a CRYPTO-random 16-byte source
//     (SecRandomCopyBytes), replacing the legacy Math.random / Hypercore-pubkey
//     derivation. pairingId = "<token>:<key>".
//   - display name + 3 codewords → UserDefaults. Codewords stored trimmed +
//     lowercased; defaults sunny/cloudy/stormy (legacy DEFAULT_CODEWORDS).
//
//  Token/key/pairingId are generated ONCE on first run and persisted; Reset
//  wipes everything and regenerates a fresh pairing on next load.
//

import Foundation
import Security

/// Observable settings model surfaced to the disguise UI and Settings screen.
@MainActor
final class SettingsStore: ObservableObject {

    // Legacy default codewords (services/settings.js DEFAULT_CODEWORDS).
    static let defaultCodewords = Codewords(tier1: "sunny", tier2: "cloudy", tier3: "stormy")

    struct Codewords: Equatable {
        var tier1: String
        var tier2: String
        var tier3: String
    }

    @Published private(set) var displayName: String = ""
    @Published private(set) var codewords: Codewords = SettingsStore.defaultCodewords
    @Published private(set) var pairingId: String = ""

    /// Token = left half of pairingId (the only value the relay uses). §1.1.
    var token: String { pairingId.split(separator: ":", maxSplits: 1).first.map(String.init) ?? "" }
    /// Key = right half of pairingId (encryption seam; never sent to relay). §1.1.
    var pairingKey: String {
        let parts = pairingId.split(separator: ":", maxSplits: 1)
        return parts.count > 1 ? String(parts[1]) : ""
    }

    // UserDefaults keys (mirrors legacy KEYS map; pairing moves to Keychain).
    private enum UD {
        static let name = "safehaven.name"
        static let codewords = "safehaven.codewords" // JSON {tier1,tier2,tier3}
    }
    // Keychain account for the pairing id blob.
    private static let keychainService = "com.fochs.safehaven"
    private static let keychainAccount = "pairingId"

    init() {
        load()
    }

    // MARK: - Load / generate

    /// Load persisted settings; generate a pairing id on first run (legacy
    /// loadSettings semantics).
    func load() {
        let defaults = UserDefaults.standard
        displayName = defaults.string(forKey: UD.name) ?? ""

        if let json = defaults.string(forKey: UD.codewords),
           let data = json.data(using: .utf8),
           let decoded = try? JSONDecoder().decode([String: String].self, from: data),
           let t1 = decoded["tier1"], let t2 = decoded["tier2"], let t3 = decoded["tier3"] {
            codewords = Codewords(tier1: t1, tier2: t2, tier3: t3)
        } else {
            codewords = SettingsStore.defaultCodewords
        }

        if let existing = Self.keychainRead(), !existing.isEmpty {
            pairingId = existing
        } else {
            let fresh = Self.generatePairingId()
            Self.keychainWrite(fresh)
            pairingId = fresh
        }
    }

    // MARK: - Save (Settings screen)

    /// Validate (legacy validateCodewords): all three required + unique.
    /// Returns an error string, or nil if valid.
    static func validate(name: String, codewords: Codewords) -> String? {
        let vals = [codewords.tier1.trimmingCharacters(in: .whitespaces),
                    codewords.tier2.trimmingCharacters(in: .whitespaces),
                    codewords.tier3.trimmingCharacters(in: .whitespaces)]
        if vals.contains(where: { $0.isEmpty }) { return "All three codewords are required." }
        if Set(vals).count < 3 { return "Each codeword must be unique." }
        return nil
    }

    /// Persist name + codewords. Codewords stored trimmed + lowercased
    /// (legacy handleSave). Throws-free; assumes validate() already passed.
    func save(name: String, codewords raw: Codewords) {
        let cleaned = Codewords(
            tier1: raw.tier1.trimmingCharacters(in: .whitespaces).lowercased(),
            tier2: raw.tier2.trimmingCharacters(in: .whitespaces).lowercased(),
            tier3: raw.tier3.trimmingCharacters(in: .whitespaces).lowercased()
        )
        let trimmedName = name.trimmingCharacters(in: .whitespaces)

        let defaults = UserDefaults.standard
        defaults.set(trimmedName, forKey: UD.name)
        if let data = try? JSONEncoder().encode([
            "tier1": cleaned.tier1, "tier2": cleaned.tier2, "tier3": cleaned.tier3,
        ]), let json = String(data: data, encoding: .utf8) {
            defaults.set(json, forKey: UD.codewords)
        }

        displayName = trimmedName
        codewords = cleaned
    }

    /// Wipe all settings and regenerate the pairing (legacy resetSettings + the
    /// "regenerate your pairing key" copy). Clears the host/TLS overrides too.
    func reset() {
        let defaults = UserDefaults.standard
        defaults.removeObject(forKey: UD.name)
        defaults.removeObject(forKey: UD.codewords)
        Self.keychainDelete()
        RelayConfig.setHostOverride(nil)
        RelayConfig.setTLSOverride(nil)
        load() // regenerates a fresh pairing id
    }

    // MARK: - Pairing URL

    /// Receiver URL with the full `<token>:<key>` in the fragment (§1.2).
    var pairingURL: String { RelayConfig.pairingURL(pairingId: pairingId) }

    // MARK: - Crypto-random pairing id (PROTOCOL §1.1)

    /// 16 cryptographically-random bytes → 32 lowercase hex chars.
    private static func randomHex32() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            // SecRandomCopyBytes effectively never fails; fall back defensively.
            for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    /// pairingId = "<token>:<key>" — token and key each 32 hex chars. §1.1.
    static func generatePairingId() -> String {
        "\(randomHex32()):\(randomHex32())"
    }

    // MARK: - Keychain (SecItem) for the pairing id

    private static func keychainRead() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private static func keychainWrite(_ value: String) {
        let data = Data(value.utf8)
        // Delete any existing item first to keep the write idempotent.
        keychainDelete()
        let attributes: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
            kSecValueData as String: data,
            // Survives reboots; available after first unlock. Not synced to iCloud.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        SecItemAdd(attributes as CFDictionary, nil)
    }

    private static func keychainDelete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: keychainAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
