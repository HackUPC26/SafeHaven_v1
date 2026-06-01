/**
 * inboundTransform.ts — ENCRYPTION SEAM (PROTOCOL §9, deferred — design only).
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  THIS IS THE RECEIVER-SIDE ENCRYPTION BOUNDARY.                            │
 * │                                                                            │
 * │  Today it is an IDENTITY PASSTHROUGH. When end-to-end encryption lands,   │
 * │  the WebCrypto/`open` (AEAD decrypt) call slots in HERE — keyed by the    │
 * │  `key` half of the pairing ID parsed from the URL fragment (pairing.ts).  │
 * │                                                                            │
 * │  Boundary (per §9):  receive → InboundTransform(decrypt) → decode         │
 * │  Only PAYLOADS are transformed. The binary header (frame.ts) and the text │
 * │  envelope ({type:"event", payload:{...}}) stay CLEARTEXT — the relay      │
 * │  routes off those and never sees plaintext payloads, which is exactly why │
 * │  encryption can drop in here without touching the relay or the framing.   │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * Symmetry note: the sender constructs a matching `OutboundTransform` with the
 * SAME key (from Keychain). Mark the seam there too. The two must agree on the
 * algorithm/format once real crypto lands.
 */

export class InboundTransform {
  /**
   * The pairing key (32 hex chars) from the URL fragment. Retained now even
   * though both transforms are no-ops, so the plumbing is real end-to-end and
   * the crypto upgrade is a localized change.
   */
  private readonly key: string;

  constructor(key: string) {
    this.key = key;
  }

  /**
   * Expose the pairing key length without leaking the key itself. Exists so the
   * key field is genuinely consumed today (it is otherwise only read by the
   * future crypto path) and so callers can assert the key was plumbed through.
   */
  get keyLength(): number {
    return this.key.length;
  }

  /**
   * Transform an inbound media payload (encoded video AU or PCM chunk).
   *
   * IDENTITY TODAY. Future: `return aeadOpen(this.key, payload)`.
   * Kept synchronous so the hot media path has no await; if AEAD requires
   * async WebCrypto later, this signature widens to Promise and callers adapt.
   */
  openMedia(payload: Uint8Array): Uint8Array {
    // ── CryptoKit/WebCrypto open() slots in here, keyed by this.key. ──
    return payload;
  }

  /**
   * Transform an inbound event payload object (the inner `payload` of a
   * {type:"event"} text frame).
   *
   * IDENTITY TODAY. Future: the wire payload would be ciphertext (e.g. a
   * base64 blob) that this method decrypts and JSON-parses back into the
   * event object. For now it returns the already-parsed object unchanged.
   */
  openEvent<T>(payload: T): T {
    // ── CryptoKit/WebCrypto open() slots in here, keyed by this.key. ──
    return payload;
  }
}
