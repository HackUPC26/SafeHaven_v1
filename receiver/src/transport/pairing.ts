/**
 * pairing.ts — receiver URL fragment parsing (PROTOCOL §1.1–§1.2).
 *
 *   Receiver URL:  https://<relay-host>/#<token>:<key>
 *   pairingId   =  "<token>:<key>"   (token and key each 32 hex chars)
 *
 * The v1 receiver MUST split the fragment on the FIRST ':':
 *   - left  = token  -> sent to the relay (the ONLY value the relay routes on)
 *   - right = key    -> retained on the client, passed to the InboundTransform
 *                       (the deferred encryption seam, §9). NEVER sent to relay.
 *   Anything after a SECOND ':' is reserved/ignored.
 *
 * This replaces the legacy receiver, which read the ENTIRE hash as the token.
 */

export interface Pairing {
  /** Relay room/session identifier (left of first ':'). */
  token: string;
  /**
   * Future-E2E key (right of first ':'). Unused today but plumbed end-to-end
   * to the InboundTransform constructor. Empty string if the fragment had no
   * ':' (legacy single-value links — token only).
   */
  key: string;
}

/**
 * Parse a location-hash style fragment into {token, key}.
 * Accepts the raw `location.hash` (may include the leading '#').
 * Returns null when there is no usable token.
 */
export function parsePairing(rawHash: string): Pairing | null {
  // Strip a single leading '#', trim whitespace.
  const frag = (rawHash || '').replace(/^#/, '').trim();
  if (!frag) return null;

  // Split on the FIRST ':' only. indexOf + slice (not String.split) so that a
  // key containing further ':' is preserved intact on the right.
  const sep = frag.indexOf(':');
  if (sep === -1) {
    // No ':' — treat the whole fragment as the token (back-compat with old
    // token-only links). Key is empty.
    return { token: frag, key: '' };
  }

  const token = frag.slice(0, sep).trim();
  const key = frag.slice(sep + 1).trim();
  if (!token) return null;

  return { token, key };
}

/**
 * Read the current pairing from `window.location.hash`. Returns null when no
 * token is present (the app then shows the TokenEntry overlay).
 */
export function readPairingFromLocation(): Pairing | null {
  return parsePairing(window.location.hash);
}
