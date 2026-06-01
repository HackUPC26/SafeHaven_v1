//
//  OutboundTransform.swift
//  SafeHaven — Transport
//
//  ╔══════════════════════════════════════════════════════════════════════════╗
//  ║  ENCRYPTION SEAM (DEFERRED — design only). PROTOCOL §9.                     ║
//  ║                                                                            ║
//  ║  Every outbound PAYLOAD (event payload object, encoded H.264 access unit,  ║
//  ║  or PCM chunk) passes through this single boundary on its way to the       ║
//  ║  socket. TODAY it is an IDENTITY passthrough. CryptoKit `seal` slots in    ║
//  ║  HERE, keyed by the `key` half of the pairing ID, WITHOUT touching the     ║
//  ║  relay or the framing/envelope (which stay cleartext).                     ║
//  ║                                                                            ║
//  ║  Boundary contract:  encode → OutboundTransform(encrypt) → send            ║
//  ║  Only payloads are transformed; the 16-byte binary header and the          ║
//  ║  { type:"event", payload:… } envelope remain cleartext so the relay can    ║
//  ║  route/cache off metadata alone and never reads the inner payload.         ║
//  ╚══════════════════════════════════════════════════════════════════════════╝
//
//  The pairing `key` is plumbed end-to-end NOW (Keychain → this constructor)
//  even though the transform is a no-op, so dropping in CryptoKit later is a
//  localized change confined to `transform(_:)`.
//

import Foundation
import CryptoKit   // reserved: SymmetricKey / AES.GCM.seal slot in here later

/// Identity-passthrough transform applied to every outbound payload.
/// Constructed with the pairing key so the future CryptoKit implementation has
/// the key material it needs without any plumbing changes.
struct OutboundTransform {

    /// The pairing `key` (32 hex chars). Unused today; future key material.
    private let pairingKey: String

    init(pairingKey: String) {
        self.pairingKey = pairingKey
    }

    /// Transform a payload before it is framed/enveloped and sent.
    ///
    /// TODAY: identity passthrough (returns `payload` unchanged).
    ///
    /// FUTURE (CryptoKit seal — DO NOT enable until the receiver's matching
    /// InboundTransform is ready and the protocol version is bumped):
    ///
    ///     let symmetricKey = SymmetricKey(/* derive from pairingKey hex */)
    ///     let sealed = try AES.GCM.seal(payload, using: symmetricKey)
    ///     return sealed.combined ?? payload   // nonce || ciphertext || tag
    ///
    /// - Parameter payload: the cleartext payload bytes (event JSON / AU / PCM).
    /// - Returns: the bytes to place after the cleartext header/envelope.
    func transform(_ payload: Data) -> Data {
        // ── SEAM: encryption goes here. Identity passthrough for now. ──
        return payload
    }
}
