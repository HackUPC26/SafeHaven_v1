//
//  CaptureCoordinator.swift
//  SafeHaven — Capture
//
//  Owns the capture graph and coordinates the AVAudioSession (PROTOCOL §5.4):
//   - ONE AVAudioEngine for the microphone. Its single input tap FANS OUT the
//     same buffer to (a) the SpeechCodewordListener (ALWAYS, so spoken codewords
//     work from idle), and — once an incident is active (Tier ≥ 1) — to (b) the
//     SoundClassifier (SoundAnalysis) and (c) the AudioStreamer (16k Int16 PCM).
//     No duplicate capture sessions / engines.
//   - ONE AVCaptureSession for the front-camera video, feeding the VideoEncoder.
//
//  Always-on listening: the engine starts at `startMonitoring()` (app launch) so
//  a SPOKEN codeword can OPEN an incident, not just escalate it. This keeps the
//  mic active while disguised (the user accepted that trade-off); it also means
//  the mic permission is requested up front and iOS shows the recording
//  indicator. The classifier + PCM streamer only run during an incident.
//
//  AVAudioSession: a single shared session, category .playAndRecord, mode
//  .measurement, options [.mixWithOthers, .allowBluetoothHFP] (verbatim from the
//  legacy AI module). The video capture session is told NOT to reconfigure it
//  (automaticallyConfiguresApplicationAudioSession = false) so starting video
//  never disrupts the running engine.
//
//  Mic permission is requested when spoken-codeword monitoring starts; camera is
//  requested on video start.
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
    /// A spoken codeword was recognized (on-device). The owner applies the same
    /// direct-to-tier logic as typed input.
    func captureCoordinator(_ c: CaptureCoordinator, didRecognizeCodeword word: String)
}

final class CaptureCoordinator: NSObject {

    weak var delegate: CaptureCoordinatorDelegate?

    // Audio graph (single engine, always-on once monitoring starts).
    private let engine = AVAudioEngine()
    private let classifier = SoundClassifier()
    private let audioStreamer = AudioStreamer()
    private let speech = SpeechCodewordListener()
    private var engineRunning = false          // mic engine + tap (runs from monitoring)
    private var audioConsumersActive = false   // classifier + PCM streamer (Tier ≥ 1)
    private var inputFormat: AVAudioFormat?

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
        speech.delegate = self
    }

    // MARK: - Monitoring (always-on, from app launch)

    /// Begin always-on mic monitoring for spoken codewords. Starts the shared
    /// engine + tap and the on-device speech listener. Requests mic permission
    /// in-context. Safe to call repeatedly; updates the codewords each time.
    func startMonitoring(codewords: [String]) {
        speech.configure(codewords: codewords)
        AVAudioApplication.requestRecordPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                print("[capture] microphone permission denied; spoken codewords unavailable (typed still works)")
                return
            }
            self.sessionQueue.async { self.startEngineIfNeeded() }
        }
    }

    private func startEngineIfNeeded() {
        guard !engineRunning else { speech.start(); return }
        do {
            // Shared AVAudioSession config — verbatim from the legacy AI module.
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord,
                                    mode: .measurement,
                                    options: [.mixWithOthers, .allowBluetoothHFP])
            try session.setActive(true)

            let inputNode = engine.inputNode
            let format = inputNode.outputFormat(forBus: 0)
            guard format.channelCount > 0, format.sampleRate > 0 else {
                print("[capture] invalid microphone input format")
                return
            }
            inputFormat = format

            // Single tap, fanned out (PROTOCOL §5.4). Speech listens ALWAYS;
            // classifier + PCM streamer only while an incident is active.
            // bufferSize 8192 matches the legacy AI module exactly.
            inputNode.installTap(onBus: 0, bufferSize: 8192, format: format) { [weak self] buffer, time in
                guard let self else { return }
                self.speech.ingest(buffer: buffer)                 // always (spoken codewords)
                if self.audioConsumersActive {
                    self.classifier.analyze(buffer: buffer, atFramePosition: time.sampleTime)
                    self.audioStreamer.ingest(buffer: buffer)
                }
            }

            engine.prepare()
            try engine.start()
            engineRunning = true
            speech.start()
        } catch {
            print("[capture] failed to start audio engine: \(error.localizedDescription)")
        }
    }

    // MARK: - Audio consumers (Tier ≥ 1)

    /// Activate the SoundAnalysis classifier + PCM streamer for an active incident.
    /// The engine is already running from monitoring; this just arms the consumers.
    func startAudio() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.startEngineIfNeeded()              // safety: ensure the engine is up
            guard let format = self.inputFormat else { return }
            self.classifier.prepare(format: format)
            self.audioStreamer.prepare(inputFormat: format)
            self.audioConsumersActive = true
        }
    }

    /// Stop the incident audio consumers, but KEEP the engine + speech listener
    /// running so spoken codewords still work at idle (Tier 0).
    func stopAudio() {
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.audioConsumersActive = false
            self.classifier.stop()
            self.audioStreamer.stop()
        }
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

    /// Stop the incident capture (video + audio consumers) on de-escalation to
    /// Tier 0, but KEEP always-on monitoring (engine + speech) alive so spoken
    /// codewords can re-open an incident. Use `stopMonitoring()` to fully stop.
    func stopAll() {
        stopVideo()
        stopAudio()
    }

    /// Fully stop everything including always-on monitoring, and release the audio
    /// session (e.g. when the user disables voice activation).
    func stopMonitoring() {
        stopVideo()
        speech.stop()
        sessionQueue.async { [weak self] in
            guard let self else { return }
            self.audioConsumersActive = false
            self.classifier.stop()
            self.audioStreamer.stop()
            if self.engineRunning {
                self.engine.inputNode.removeTap(onBus: 0)
                self.engine.stop()
                self.engineRunning = false
            }
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
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.captureCoordinator(self, didEmitAILabel: label, confidence: confidence, rawIdentifier: rawIdentifier)
        }
    }
}

// MARK: - Spoken codeword → delegate

extension CaptureCoordinator: SpeechCodewordListenerDelegate {
    func speechCodewordListener(_ listener: SpeechCodewordListener, didHear word: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.captureCoordinator(self, didRecognizeCodeword: word)
        }
    }
}
