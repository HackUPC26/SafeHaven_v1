//
//  AudioStreamer.swift
//  SafeHaven — Capture
//
//  Converts the shared mic buffer to streamable PCM and packetizes it. PROTOCOL
//  §4.2: 16-bit signed integer, little-endian, MONO, 16 kHz, ~20 ms chunks
//  (320 samples = 640 bytes payload), kind = AUDIO_PCM, cacheClass = none.
//
//  This is INDEPENDENT of the SoundAnalysis tap (§5.4): both consume the same
//  single AVAudioEngine input buffer, fanned out by CaptureCoordinator. Here we
//  use an AVAudioConverter to resample from the engine's native input format to
//  16 kHz Int16 mono, accumulate samples, and emit fixed 320-sample chunks via
//  the transport. PTS is derived from a running sample counter against the 16k
//  output clock (microseconds).
//

import Foundation
import AVFoundation

protocol AudioStreamerDelegate: AnyObject {
    /// Emit one ~20 ms PCM chunk (kind=2, cacheClass=none). PROTOCOL §4.2.
    func audioStreamer(_ streamer: AudioStreamer, didProducePCMChunk data: Data, ptsMicros: UInt64)
}

final class AudioStreamer {

    weak var delegate: AudioStreamerDelegate?

    // Output format: 16 kHz, mono, Int16, interleaved, little-endian.
    private let targetSampleRate: Double = 16_000
    private let samplesPerChunk = 320          // 20 ms @ 16 kHz
    private var bytesPerChunk: Int { samplesPerChunk * MemoryLayout<Int16>.size } // 640

    private var converter: AVAudioConverter?
    private var outputFormat: AVAudioFormat?

    /// Accumulates converted Int16 LE bytes until a full 20 ms chunk is ready.
    private var pending = Data()
    /// Running output-sample counter, used to compute PTS in microseconds.
    private var totalOutputSamples: UInt64 = 0

    private let lock = NSLock()
    private var isRunning = false

    // MARK: - Lifecycle

    /// Build the converter from the engine's input format to 16k Int16 mono.
    func prepare(inputFormat: AVAudioFormat) {
        lock.lock(); defer { lock.unlock() }

        guard let outFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: targetSampleRate,
            channels: 1,
            interleaved: true
        ) else {
            print("[audio] failed to build 16k Int16 mono output format")
            return
        }
        outputFormat = outFormat
        converter = AVAudioConverter(from: inputFormat, to: outFormat)
        pending.removeAll(keepingCapacity: true)
        totalOutputSamples = 0
        isRunning = true
    }

    func stop() {
        lock.lock(); defer { lock.unlock() }
        isRunning = false
        converter = nil
        outputFormat = nil
        pending.removeAll(keepingCapacity: true)
        totalOutputSamples = 0
    }

    // MARK: - Buffer ingestion (fanned from the shared engine tap)

    /// Convert one input buffer to 16k Int16 mono and emit any complete chunks.
    func ingest(buffer: AVAudioPCMBuffer) {
        lock.lock()
        guard isRunning, let converter, let outputFormat else { lock.unlock(); return }
        lock.unlock()

        // Size the output buffer generously: convert input frames at the output
        // sample rate, rounding up, with headroom.
        let ratio = targetSampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio + 1024)
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return
        }

        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
            // Provide the source buffer exactly once; signal endOfStream after.
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }

        if status == .error {
            if let conversionError {
                print("[audio] convert error: \(conversionError.localizedDescription)")
            }
            return
        }

        let frames = Int(outBuffer.frameLength)
        guard frames > 0, let channelData = outBuffer.int16ChannelData else { return }

        // Interleaved mono → channel 0 holds all samples contiguously.
        let samplePtr = channelData[0]
        let byteCount = frames * MemoryLayout<Int16>.size
        let chunkData = Data(bytes: samplePtr, count: byteCount)

        emitChunks(appending: chunkData)
    }

    // MARK: - Packetization

    /// Append freshly converted bytes and emit as many full 20 ms chunks as
    /// possible, computing PTS per chunk from the output-sample clock.
    private func emitChunks(appending newBytes: Data) {
        lock.lock()
        guard isRunning else { lock.unlock(); return }
        pending.append(newBytes)

        var chunksToEmit: [(Data, UInt64)] = []
        while pending.count >= bytesPerChunk {
            let chunk = pending.prefix(bytesPerChunk)
            // PTS = (samples emitted so far) / 16000 s, in microseconds.
            let ptsMicros = totalOutputSamples * 1_000_000 / UInt64(targetSampleRate)
            chunksToEmit.append((Data(chunk), ptsMicros))

            totalOutputSamples += UInt64(samplesPerChunk)
            pending.removeFirst(bytesPerChunk)
        }
        lock.unlock()

        for (data, pts) in chunksToEmit {
            delegate?.audioStreamer(self, didProducePCMChunk: data, ptsMicros: pts)
        }
    }
}
