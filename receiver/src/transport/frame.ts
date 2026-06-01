/**
 * frame.ts — binary media frame parsing (PROTOCOL §3).
 *
 * Every WS BINARY frame is a fixed 16-byte LITTLE-ENDIAN header followed by an
 * opaque payload. The header is ALWAYS cleartext; the payload is the part the
 * encryption seam (§9) will transform later (see inboundTransform.ts).
 *
 *   offset size  field        notes
 *   0      1     version      = 0x01
 *   1      1     kind         1 = VIDEO_H264, 2 = AUDIO_PCM
 *   2      1     flags        bit0 = KEYFRAME (IDR) for video; 0 for audio
 *   3      1     cacheClass   0 = none, 1 = retain-last-of-kind
 *   4      4     seq          uint32, per-kind monotonic (resets on sender reconnect)
 *   8      8     ptsMicros    uint64, presentation timestamp in microseconds
 *   16     ...   payload      encoded video access unit OR PCM chunk (opaque)
 */

export const FRAME_VERSION = 0x01;
export const HEADER_BYTES = 16;

/** Media kind discriminator (header byte[1]). */
export enum MediaKind {
  Video = 1, // VIDEO_H264
  Audio = 2, // AUDIO_PCM
}

/** flags bit0 — set on video IDR access units. */
export const FLAG_KEYFRAME = 0x01;

/** A parsed binary media frame. `payload` is a view INTO the original buffer. */
export interface MediaFrame {
  version: number;
  kind: MediaKind;
  /** True when flags.bit0 is set (video IDR). Always false for audio. */
  keyframe: boolean;
  /** 0 = none, 1 = retain-last-of-kind. */
  cacheClass: number;
  /** Per-kind monotonic sequence; resets on sender reconnect. */
  seq: number;
  /** Presentation timestamp in microseconds (capture clock). */
  ptsMicros: number;
  /**
   * Opaque payload bytes. This is a Uint8Array VIEW over the source
   * ArrayBuffer (no copy). Consumers that retain it past the current tick
   * should copy if the source buffer may be reused.
   */
  payload: Uint8Array;
}

/**
 * Parse a 16-byte LE header + payload out of an ArrayBuffer received on the
 * WebSocket. Returns null if the buffer is too short or the version byte is
 * unrecognized (defensive — a malformed frame must never crash the receiver).
 *
 * ptsMicros is read with DataView.getBigUint64 then narrowed to a JS number.
 * Microsecond timestamps stay well within Number.MAX_SAFE_INTEGER for any
 * realistic capture clock, so the narrowing is lossless in practice.
 */
export function parseMediaFrame(buffer: ArrayBuffer): MediaFrame | null {
  if (buffer.byteLength < HEADER_BYTES) return null;

  const view = new DataView(buffer);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) return null;

  const kind = view.getUint8(1) as MediaKind;
  const flags = view.getUint8(2);
  const cacheClass = view.getUint8(3);
  // little-endian for ALL multi-byte fields (§3).
  const seq = view.getUint32(4, /* littleEndian */ true);
  const ptsMicros = Number(view.getBigUint64(8, /* littleEndian */ true));

  // Payload is everything after the header. Zero-copy view.
  const payload = new Uint8Array(buffer, HEADER_BYTES, buffer.byteLength - HEADER_BYTES);

  return {
    version,
    kind,
    keyframe: (flags & FLAG_KEYFRAME) !== 0,
    cacheClass,
    seq,
    ptsMicros,
    payload,
  };
}
