//
//  VideoEncoder.swift
//  SafeHaven — Capture
//
//  H.264 encoder built on VideoToolbox's VTCompressionSession. PROTOCOL §4.1:
//   - codec H.264, fixed 720p, AverageBitRate ≈ 2 Mbps, RealTime = true,
//     AllowFrameReordering = false (no B-frames), Baseline profile.
//   - Force an IDR every 2 seconds; MaxKeyFrameInterval ≈ 2 × fps.
//   - VideoToolbox emits AVCC (length-prefixed NALs) with SPS/PPS in the format
//     description. We CONVERT to Annex-B (4-byte 00 00 00 01 start codes) and
//     PREPEND SPS + PPS to EVERY IDR access unit so each keyframe is
//     independently decodable. Delta frames are Annex-B without parameter sets.
//   - Each Annex-B access unit becomes one binary frame: kind = VIDEO_H264,
//     flags.KEYFRAME on IDR, cacheClass = retain-last-of-kind on IDR else none.
//
//  The encoder is fed CMSampleBuffers from CaptureCoordinator's video output. It
//  hands finished Annex-B access units back via the delegate, which forwards
//  them to the transport. `forceKeyframe()` services presence/receiver_joined
//  (PROTOCOL §6.2) and the initial connect.
//

import Foundation
import VideoToolbox
import CoreMedia

protocol VideoEncoderDelegate: AnyObject {
    /// One encoded Annex-B access unit ready to frame + send.
    /// - isKeyframe: true for IDR (set flags.KEYFRAME, cacheClass=retain).
    func videoEncoder(_ encoder: VideoEncoder,
                      didEncode annexB: Data,
                      isKeyframe: Bool,
                      ptsMicros: UInt64)
}

final class VideoEncoder {

    weak var delegate: VideoEncoderDelegate?

    private var session: VTCompressionSession?
    private let width: Int32 = 1280
    private let height: Int32 = 720
    private let targetBitrate: Int = 2_000_000   // ~2 Mbps
    private let expectedFPS: Int32 = 30

    /// Set by CaptureCoordinator when a forced IDR is needed on the next frame.
    private var forceKeyframeNext = false
    private let lock = NSLock()

    // MARK: - Lifecycle

    /// Create the compression session with the protocol's encoding properties.
    func start() {
        lock.lock(); defer { lock.unlock() }
        guard session == nil else { return }

        var newSession: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: width,
            height: height,
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,           // using the block-based encode API
            refcon: nil,
            compressionSessionOut: &newSession
        )

        guard status == noErr, let session = newSession else {
            print("[video] VTCompressionSessionCreate failed: \(status)")
            return
        }

        // Baseline profile maximizes browser decode compatibility (avc1.42E01F).
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel,
                             value: kVTProfileLevel_H264_Baseline_AutoLevel)
        // Real-time, low-latency: no B-frames / frame reordering.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime,
                             value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering,
                             value: kCFBooleanFalse)
        // Target bitrate ≈ 2 Mbps.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate,
                             value: NSNumber(value: targetBitrate))
        // IDR cadence: keyframe interval ≈ 2 × fps, and ~2s by duration.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval,
                             value: NSNumber(value: expectedFPS * 2))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
                             value: NSNumber(value: 2.0))
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ExpectedFrameRate,
                             value: NSNumber(value: expectedFPS))

        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
        forceKeyframeNext = true   // first emitted frame should be an IDR
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }

    /// Request that the next encoded frame be a forced IDR (presence join / §6.2).
    func forceKeyframe() {
        lock.lock(); forceKeyframeNext = true; lock.unlock()
    }

    // MARK: - Encode

    /// Encode one captured video frame (CMSampleBuffer from the capture output).
    func encode(sampleBuffer: CMSampleBuffer) {
        lock.lock()
        guard let session,
              let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            lock.unlock(); return
        }
        let forceKey = forceKeyframeNext
        forceKeyframeNext = false
        lock.unlock()

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let duration = CMSampleBufferGetDuration(sampleBuffer)

        var properties: [String: Any]? = nil
        if forceKey {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame as String: true]
        }

        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: imageBuffer,
            presentationTimeStamp: pts,
            duration: duration,
            frameProperties: properties as CFDictionary?,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard let self else { return }
            guard status == noErr, let sampleBuffer else {
                if status != noErr { print("[video] encode callback status: \(status)") }
                return
            }
            self.handleEncoded(sampleBuffer)
        }
    }

    // MARK: - AVCC → Annex-B

    private func handleEncoded(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let isKeyframe = Self.sampleIsKeyframe(sampleBuffer)
        let ptsCM = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ptsMicros = UInt64(max(0, CMTimeGetSeconds(ptsCM) * 1_000_000))

        var annexB = Data()

        // Prepend SPS + PPS to EVERY IDR so each keyframe is self-contained.
        if isKeyframe, let formatDesc = CMSampleBufferGetFormatDescription(sampleBuffer) {
            for paramSet in Self.parameterSets(from: formatDesc) {
                annexB.append(Self.startCode)
                annexB.append(paramSet)
            }
        }

        // Convert the AVCC length-prefixed NAL units to Annex-B start-code form.
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var lengthAtOffset = 0
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(blockBuffer,
                                                 atOffset: 0,
                                                 lengthAtOffsetOut: &lengthAtOffset,
                                                 totalLengthOut: &totalLength,
                                                 dataPointerOut: &dataPointer)
        guard status == kCMBlockBufferNoErr, let dataPointer else { return }

        // AVCC uses 4-byte big-endian NAL length prefixes (the default for
        // VideoToolbox H.264). Walk them and replace each prefix with a start code.
        var offset = 0
        let nalHeaderLength = 4
        dataPointer.withMemoryRebound(to: UInt8.self, capacity: totalLength) { bytes in
            while offset + nalHeaderLength <= totalLength {
                // Read big-endian 4-byte NAL length.
                let nalLength = (UInt32(bytes[offset]) << 24)
                              | (UInt32(bytes[offset + 1]) << 16)
                              | (UInt32(bytes[offset + 2]) << 8)
                              |  UInt32(bytes[offset + 3])
                let nalStart = offset + nalHeaderLength
                let nalSize = Int(nalLength)
                guard nalSize > 0, nalStart + nalSize <= totalLength else { break }

                annexB.append(Self.startCode)
                annexB.append(Data(bytes: bytes + nalStart, count: nalSize))
                offset = nalStart + nalSize
            }
        }

        guard !annexB.isEmpty else { return }
        delegate?.videoEncoder(self, didEncode: annexB, isKeyframe: isKeyframe, ptsMicros: ptsMicros)
    }

    // MARK: - Helpers

    /// 4-byte Annex-B start code (00 00 00 01).
    private static let startCode = Data([0x00, 0x00, 0x00, 0x01])

    /// True if the sample buffer is an IDR (no "not sync" attachment).
    private static func sampleIsKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0 else {
            return true // no attachments → treat as sync (keyframe)
        }
        let dict = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
        // If kCMSampleAttachmentKey_NotSync is present and true, it's a delta frame.
        let key = unsafeBitCast(kCMSampleAttachmentKey_NotSync, to: UnsafeRawPointer.self)
        if CFDictionaryContainsKey(dict, key) {
            let value = unsafeBitCast(CFDictionaryGetValue(dict, key), to: CFBoolean.self)
            return !CFBooleanGetValue(value)
        }
        return true
    }

    /// Extract the SPS + PPS parameter sets (raw NAL payloads) from the format
    /// description, in order. Used to prepend to each IDR access unit.
    private static func parameterSets(from formatDesc: CMFormatDescription) -> [Data] {
        var sets: [Data] = []
        var count = 0
        // First query the number of parameter sets.
        let firstStatus = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            formatDesc, parameterSetIndex: 0,
            parameterSetPointerOut: nil, parameterSetSizeOut: nil,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil
        )
        guard firstStatus == noErr, count > 0 else { return sets }

        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                formatDesc, parameterSetIndex: index,
                parameterSetPointerOut: &pointer, parameterSetSizeOut: &size,
                parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
            )
            if status == noErr, let pointer, size > 0 {
                sets.append(Data(bytes: pointer, count: size))
            }
        }
        return sets
    }
}
