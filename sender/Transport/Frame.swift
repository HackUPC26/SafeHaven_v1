//
//  Frame.swift
//  SafeHaven — Transport
//
//  Builds the fixed 16-byte little-endian binary media header defined in
//  PROTOCOL §3. Every binary WebSocket frame is this header followed by an
//  opaque payload (H.264 Annex-B access unit or PCM chunk). The header is
//  ALWAYS cleartext; only the payload passes through the encryption seam (§9).
//
//      offset size  field        notes
//      0      1     version      = 0x01
//      1      1     kind         1 = VIDEO_H264, 2 = AUDIO_PCM
//      2      1     flags        bit0 = KEYFRAME (IDR) for video; audio = 0
//      3      1     cacheClass   0 = none, 1 = retain-last-of-kind
//      4      4     seq          uint32 LE, per-kind monotonic from the sender
//      8      8     ptsMicros    uint64 LE, presentation time in microseconds
//      16     ...   payload      encoded access unit OR PCM chunk
//

import Foundation

/// Media stream kind (header byte[1]). PROTOCOL §3.
enum FrameKind: UInt8 {
    case video = 1   // VIDEO_H264
    case audio = 2   // AUDIO_PCM
}

/// Header flag bits (header byte[2]). PROTOCOL §3.
struct FrameFlags: OptionSet {
    let rawValue: UInt8
    /// bit0 — set on H.264 IDR (keyframe) access units; never set for audio.
    static let keyframe = FrameFlags(rawValue: 1 << 0)
}

/// Cache class (header byte[3]) — instructs the relay's media cache. PROTOCOL §3/§7.
enum CacheClass: UInt8 {
    case none = 0            // do not retain (audio, delta video)
    case retainLastOfKind = 1 // retain-last-of-kind (latest IDR only)
}

/// The protocol version byte (header byte[0]).
private let kFrameVersion: UInt8 = 0x01

/// Length of the fixed binary header in bytes.
let kFrameHeaderLength = 16

enum Frame {

    /// Build a complete binary frame: 16-byte LE header + payload.
    ///
    /// - Parameters:
    ///   - kind: VIDEO_H264 or AUDIO_PCM.
    ///   - flags: keyframe flag for IDR video; empty otherwise.
    ///   - cacheClass: retain-last-of-kind on IDR; none otherwise.
    ///   - seq: per-kind monotonic sequence (resets on sender reconnect).
    ///   - ptsMicros: capture-clock presentation timestamp in microseconds.
    ///   - payload: the opaque (already-transformed) payload bytes.
    static func make(kind: FrameKind,
                     flags: FrameFlags,
                     cacheClass: CacheClass,
                     seq: UInt32,
                     ptsMicros: UInt64,
                     payload: Data) -> Data {
        var data = Data(capacity: kFrameHeaderLength + payload.count)

        // byte[0] version
        data.append(kFrameVersion)
        // byte[1] kind
        data.append(kind.rawValue)
        // byte[2] flags
        data.append(flags.rawValue)
        // byte[3] cacheClass
        data.append(cacheClass.rawValue)
        // bytes[4..8) seq, little-endian u32
        appendLittleEndian(&data, seq)
        // bytes[8..16) ptsMicros, little-endian u64
        appendLittleEndian(&data, ptsMicros)
        // bytes[16..] payload
        data.append(payload)

        return data
    }

    // MARK: - Little-endian writers

    private static func appendLittleEndian(_ data: inout Data, _ value: UInt32) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }

    private static func appendLittleEndian(_ data: inout Data, _ value: UInt64) {
        var le = value.littleEndian
        withUnsafeBytes(of: &le) { data.append(contentsOf: $0) }
    }
}
