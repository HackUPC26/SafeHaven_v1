//
//  SpeechCodewordListener.swift
//  SafeHaven — AI
//
//  On-device speech recognition that listens for the user's configured codewords
//  and reports any match, so the codeword can be SPOKEN (typing remains the
//  fallback in TierController). Privacy: recognition is forced on-device
//  (requiresOnDeviceRecognition = true) — no audio or transcript ever leaves the
//  device, consistent with SafeHaven's no-cloud posture and the roadmap's
//  Guideline 5.1.2 disclosure (all AI is local).
//
//  It is fed microphone buffers by CaptureCoordinator's single shared AVAudioEngine
//  tap (PROTOCOL §5.4 — one engine), and runs from the moment monitoring starts
//  (idle/Tier 0) so a spoken codeword can OPEN an incident, not just escalate it.
//  The monotonic tier logic that decides what each codeword does lives in
//  TierController.handleCodewordInput, reused verbatim for typed and spoken input.
//

import Foundation
import Speech
import AVFoundation

protocol SpeechCodewordListenerDelegate: AnyObject {
    /// A configured codeword was heard. The receiver applies the same monotonic
    /// escalation logic as typed input (TierController.handleCodewordInput).
    func speechCodewordListener(_ listener: SpeechCodewordListener, didHear word: String)
}

final class SpeechCodewordListener {

    weak var delegate: SpeechCodewordListenerDelegate?

    private let recognizer = SFSpeechRecognizer()   // user's current locale
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var running = false

    /// The configured codewords to listen for (lowercased). Set from settings.
    private var codewords: [String] = []

    /// Serializes recognition state. Recognition-result callbacks may arrive on an
    /// arbitrary queue; mutations are funnelled here.
    private let queue = DispatchQueue(label: "safehaven.speech.codeword")

    /// Set / update the codewords to match (defaults sunny/cloudy/stormy).
    func configure(codewords: [String]) {
        let cleaned = codewords.map { $0.lowercased().trimmingCharacters(in: .whitespaces) }
                               .filter { !$0.isEmpty }
        queue.async { self.codewords = cleaned }
    }

    /// Request authorization and begin listening. Idempotent. If speech recognition
    /// is unavailable / unauthorized / not on-device, this is a no-op — typed
    /// codewords still work.
    func start() {
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            guard let self else { return }
            guard status == .authorized else {
                print("[speech] not authorized (status \(status.rawValue)); typed codewords still work")
                return
            }
            self.queue.async { self.startTaskOnQueue() }
        }
    }

    /// Append a mic buffer from the shared engine tap.
    func ingest(buffer: AVAudioPCMBuffer) {
        queue.async { self.request?.append(buffer) }
    }

    func stop() {
        queue.async {
            self.task?.cancel()
            self.task = nil
            self.request = nil
            self.running = false
        }
    }

    // MARK: - Private (on `queue`)

    private func startTaskOnQueue() {
        guard !running else { return }
        guard let recognizer, recognizer.isAvailable else {
            print("[speech] recognizer unavailable; typed codewords still work")
            return
        }
        guard recognizer.supportsOnDeviceRecognition else {
            // Refuse cloud recognition — audio must never leave the device.
            print("[speech] on-device recognition unsupported here; not enabling (privacy)")
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        if #available(iOS 17.0, *) { req.addsPunctuation = false }

        request = req
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            if let result {
                self.handleTranscription(result.bestTranscription.formattedString)
            }
            if error != nil || (result?.isFinal ?? false) {
                // On-device tasks end periodically; cycle a fresh one to keep
                // listening continuously.
                self.queue.async { self.restartOnQueue() }
            }
        }
        running = true
    }

    private func handleTranscription(_ text: String) {
        // Scan only the last few spoken words so we react to a freshly-said
        // codeword rather than re-matching old transcript history.
        let words = text.lowercased()
            .split(whereSeparator: { !$0.isLetter })
            .suffix(4)
            .map(String.init)
        for cw in codewords where words.contains(cw) {
            // Hand off to the @MainActor delegate, then restart so the same
            // utterance isn't matched twice.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.delegate?.speechCodewordListener(self, didHear: cw)
            }
            queue.async { self.restartOnQueue() }
            return
        }
    }

    private func restartOnQueue() {
        task?.cancel()
        task = nil
        request = nil
        running = false
        startTaskOnQueue()
    }
}
