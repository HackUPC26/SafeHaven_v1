//
//  CaptureCoordinator.swift
//  SafeHaven — Capture
//
//  Owns the capture graph and coordinates the AVAudioSession (PROTOCOL §5.4):
//   - ONE AVAudioEngine for the microphone. Its single input tap FANS OUT the
//     same buffer to BOTH (a) the SoundClassifier (SoundAnalysis) and (b) the
//     AudioStreamer (16k Int16 PCM packetizer). No duplicate capture sessions.
//   - ONE AVCaptureSession for the front-camera video, feeding the VideoEncoder.
//
//  AVAudioSession coordination: a SINGLE shared session configured exactly as
//  the legacy AI module (PROTOCOL §5.3): category .playAndRecord, mode
//  .measurement, options [.mixWithOthers, .allowBluetoothHFP]. .playAndRecord is
//  required because the receiver/operator may also need audio routing and it
//  keeps the mic alive while backgrounded (UIBackgroundModes: audio). The same
//  session serves both the engine and the capture session.
//
//  Tier gating (driven by TierController):
//   - audio (engine + classifier + PCM) and video are started/stopped here.
//   - Video begins at Tier ≥ 2 (PROTOCOL §4.1 / decisions §0). Audio + GPS +
//     classification begin at Tier ≥ 1 (GPS/classification are wired by
//     TierController; this coordinator handles the audio engine + video).
//
//  Permissions are requested IN-CONTEXT (on first start of each subsystem),
//  never at first launch.
//

import Foundation
import AVFoundation

/// Main-actor isolated: the owner (TierController) is @MainActor. The capture,
/// encode, and analysis callbacks below originate on background queues, so each
/// delegate invocation hops to the main actor before calling out.
@MainActor
protocol CaptureCoordinatorDelegate: AnyObject {
    /// An encoded H.264 Annex-B video access unit is ready to send.
    func captureCoordinator(_ c: CaptureCoordinator,
                            didEncodeVideo annexB: Data,
                            isKeyframe: Bool,
                            ptsMicros: UInt64)
    /// A ~20 ms PCM audio chunk is ready to send.
    func captureCoordinator(_ c: CaptureCoordinator,
                            didProduceAudio data: Data,
                            ptsMicros: UInt64)
    /// The on-device classifier emitted a mapped AI label.
    func captureCoordinator(_ c: CaptureCoordinator,
                            didEmitAILabel label: String,
                            confidence: Double,
                            rawIdentifier: String)
}

final class CaptureCoordinator: NSObject {

    weak var delegate: CaptureCoordinatorDelegate?

    // Audio graph (single engine).
    private let engine = AVAudioEngine()
    private let classifier = SoundClassifier()
    private let audioStreamer = AudioStreamer()
    private var audioRunning = false

    // Video graph (single capture session).
    private let captureSession = AVCaptureSession()
    private let videoEncoder = VideoEncoder()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let videoQueue = DispatchQueue(label: "safehaven.capture.video")
    private var videoRunning = false
    private let sessionQueue = DispatchQueue(label: "safehaven.capture.session")

    override init() {
        super.init()
        classifier.delegate = self
        audioStreamer.delegate = self
        videoEncoder.delegate = self
    }

    // MARK: - Audio (Tier ≥ 1)

    /// Start the shared audio engine and fan its mic buffer to the classifier
    /// (SoundAnalysis) and the PCM streamer. Requests mic permission in-context.
    func startAudio() {
        guard !audioRunning else { return }

        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                print("[capture] microphone permission denied")
                return
            }
            self.sessionQueue.async {
                self.startAudioEngine()
            }
        }
    }

    private func startAudioEngine() {
        guard !audioRunning else { return }
        do {
            // Shared AVAudioSession config — verbatim from the legacy AI module.
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord,
                                    mode: .measurement,
                                    options: [.mixWithOthers, .allowBluetoothHFP])
            try session.setActive(true)

            let inputNode = engine.inputNode
            let inputFormat = inputNode.outputFormat(forBus: 0)
            guard inputFormat.channelCount > 0, inputFormat.sampleRate > 0 else {
                print("[capture] invalid microphone input format")
                return
            }

            // Arm both consumers for this input format.
            classifier.prepare(format: inputFormat)
            audioStreamer.prepare(inputFormat: inputFormat)

            // Single tap, fanned out to both consumers (PROTOCOL §5.4).
            // bufferSize 8192 matches the legacy AI module exactly.
            inputNode.installTap(onBus: 0, bufferSize: 8192, format: inputFormat) { [weak self] buffer, time in
                guard let self else { return }
                // (a) SoundAnalysis classifier.
                self.classifier.analyze(buffer: buffer, atFramePosition: time.sampleTime)
                // (b) PCM downsample/packetize for streaming.
                self.audioStreamer.ingest(buffer: buffer)
            }

            engine.prepare()
            try engine.start()
            audioRunning = true
        } catch {
            print("[capture] failed to start audio engine: \(error.localizedDescription)")
            stopAudioEngine()
        }
    }

    func stopAudio() {
        sessionQueue.async { [weak self] in
            self?.stopAudioEngine()
        }
    }

    private func stopAudioEngine() {
        guard audioRunning || engine.isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        classifier.stop()
        audioStreamer.stop()
        audioRunning = false
    }

    // MARK: - Video (Tier ≥ 2)

    /// Start front-camera capture + H.264 encode. Requests camera permission
    /// in-context. Video begins at Tier ≥ 2 per PROTOCOL §4.1.
    func startVideo() {
        guard !videoRunning else { return }

        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
            guard let self else { return }
            guard granted else {
                print("[capture] camera permission denied")
                return
            }
            self.sessionQueue.async {
                self.configureAndStartCapture()
            }
        }
    }

    private func configureAndStartCapture() {
        guard !videoRunning else { return }

        captureSession.beginConfiguration()
        // CRITICAL: do NOT let the capture session reconfigure the app's shared
        // AVAudioSession. By default it does, which clobbers the .playAndRecord/
        // .measurement session our AVAudioEngine is using and kills the mic tap —
        // breaking SoundAnalysis AND streamed PCM the moment video starts (T2).
        captureSession.automaticallyConfiguresApplicationAudioSession = false
        captureSession.sessionPreset = .hd1280x720   // fixed 720p (PROTOCOL §4.1)

        // Front camera input.
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front),
              let input = try? AVCaptureDeviceInput(device: device),
              captureSession.canAddInput(input) else {
            print("[capture] cannot add front camera input")
            captureSession.commitConfiguration()
            return
        }
        captureSession.addInput(input)

        // Video data output → our encoder.
        videoOutput.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarFullRange)
        ]
        videoOutput.alwaysDiscardsLateVideoFrames = true
        videoOutput.setSampleBufferDelegate(self, queue: videoQueue)
        guard captureSession.canAddOutput(videoOutput) else {
            print("[capture] cannot add video output")
            captureSession.commitConfiguration()
            return
        }
        captureSession.addOutput(videoOutput)

        // Portrait orientation to match the disguise app.
        if let connection = videoOutput.connection(with: .video) {
            if connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90   // portrait (iOS 17 API)
            }
            if connection.isVideoMirroringSupported {
                connection.automaticallyAdjustsVideoMirroring = false
                connection.isVideoMirrored = true     // front camera
            }
        }

        captureSession.commitConfiguration()

        videoEncoder.start()
        captureSession.startRunning()
        videoRunning = true
    }

    func stopVideo() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            guard self.videoRunning else { return }
            self.captureSession.stopRunning()
            self.captureSession.beginConfiguration()
            for input in self.captureSession.inputs { self.captureSession.removeInput(input) }
            for output in self.captureSession.outputs { self.captureSession.removeOutput(output) }
            self.captureSession.commitConfiguration()
            self.videoEncoder.stop()
            self.videoRunning = false
        }
    }

    /// Force an IDR on the next encoded frame (presence receiver_joined, §6.2).
    func forceVideoKeyframe() {
        videoEncoder.forceKeyframe()
    }

    /// Whether video is currently encoding (used to decide whether a forced IDR
    /// is meaningful when a receiver joins).
    var isVideoRunning: Bool { videoRunning }

    // MARK: - Teardown

    /// Stop everything and deactivate the audio session (on de-escalation to T0).
    func stopAll() {
        stopVideo()
        stopAudio()
        sessionQueue.async {
            try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
        }
    }
}

// MARK: - Video frames → encoder

extension CaptureCoordinator: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        videoEncoder.encode(sampleBuffer: sampleBuffer)
    }
}

// MARK: - Encoder output → delegate

extension CaptureCoordinator: VideoEncoderDelegate {
    func videoEncoder(_ encoder: VideoEncoder, didEncode annexB: Data, isKeyframe: Bool, ptsMicros: UInt64) {
        // VT callback runs on a background queue — hop to the main actor for the
        // @MainActor delegate (TierController).
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.captureCoordinator(self, didEncodeVideo: annexB, isKeyframe: isKeyframe, ptsMicros: ptsMicros)
        }
    }
}

// MARK: - PCM output → delegate

extension CaptureCoordinator: AudioStreamerDelegate {
    func audioStreamer(_ streamer: AudioStreamer, didProducePCMChunk data: Data, ptsMicros: UInt64) {
        // Emitted from the audio tap thread — hop to the main actor.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.captureCoordinator(self, didProduceAudio: data, ptsMicros: ptsMicros)
        }
    }
}

// MARK: - Classifier output → delegate

extension CaptureCoordinator: SoundClassifierDelegate {
    func soundClassifier(_ classifier: SoundClassifier,
                         didEmitLabel label: String,
                         confidence: Double,
                         rawIdentifier: String) {
        // The classifier already emits on the main queue; re-dispatch to satisfy
        // the @MainActor delegate isolation regardless.
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.captureCoordinator(self, didEmitAILabel: label, confidence: confidence, rawIdentifier: rawIdentifier)
        }
    }
}
