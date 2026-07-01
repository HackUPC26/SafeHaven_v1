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
    private var listening = false
    private var authorizationRequested = false
    private var authorized = false
    private var taskGeneration = 0
    private var restartScheduled = false
    private var loggedFirstInputBuffer = false
    private var loggedFirstAppend = false
    private var loggedMissingRequest = false
    private var loggedFirstResult = false
    private var loggedTaskStarted = false
    private var loggedNoSpeechRestart = false
    private var lastDeliveredCodeword: String?
    private var lastDeliveredAt = Date.distantPast

    /// The configured codewords to listen for (lowercased). Set from settings.
    private var codewords: [String] = []

    /// Serializes recognition state. Recognition-result callbacks may arrive on an
    /// arbitrary queue; mutations are funnelled here.
    private let queue = DispatchQueue(label: "safehaven.speech.codeword")

    /// Set / update the codewords to match (defaults sunny/cloudy/stormy).
    func configure(codewords: [String]) {
        let cleaned = codewords.map { $0.lowercased().trimmingCharacters(in: .whitespaces) }
                               .filter { !$0.isEmpty }
        queue.async {
            self.codewords = cleaned
            print("[speech] configured \(cleaned.count) spoken codeword(s)")
        }
    }

    /// Request authorization and begin listening. Idempotent. If speech recognition
    /// is unavailable / unauthorized / not on-device, this is a no-op — typed
    /// codewords still work.
    func start() {
        queue.async {
            guard !self.listening else { return }
            self.listening = true

            if self.authorized {
                self.startTaskOnQueue()
                return
            }

            guard !self.authorizationRequested else { return }
            self.authorizationRequested = true
            print("[speech] requesting authorization")
            SFSpeechRecognizer.requestAuthorization { [weak self] status in
                guard let self else { return }
                self.queue.async {
                    self.authorizationRequested = false
                    guard status == .authorized else {
                        self.listening = false
                        print("[speech] not authorized (status \(status.rawValue)); typed codewords still work")
                        return
                    }
                    self.authorized = true
                    print("[speech] authorized")
                    if self.listening {
                        self.startTaskOnQueue()
                    }
                }
            }
        }
    }

    /// Append a mic buffer from the shared engine tap.
    func ingest(buffer: AVAudioPCMBuffer) {
        if !loggedFirstInputBuffer {
            loggedFirstInputBuffer = true
            print("[speech] first mic buffer received: \(buffer.frameLength) frames @ \(buffer.format.sampleRate) Hz, \(buffer.format.channelCount) channel(s)")
        }
        guard let copiedBuffer = Self.copyBuffer(buffer) else {
            print("[speech] failed to copy mic buffer")
            return
        }
        queue.async {
            guard let request = self.request else {
                if !self.loggedMissingRequest {
                    self.loggedMissingRequest = true
                    print("[speech] mic buffers are arriving before recognition request is ready")
                }
                return
            }
            if !self.loggedFirstAppend {
                self.loggedFirstAppend = true
                print("[speech] appending mic buffers to recognition request")
            }
            request.append(copiedBuffer)
        }
    }

    func stop() {
        queue.async {
            self.listening = false
            self.cancelTaskOnQueue()
            self.loggedFirstAppend = false
            self.loggedMissingRequest = false
            self.loggedFirstResult = false
            self.loggedTaskStarted = false
            self.loggedNoSpeechRestart = false
            self.lastDeliveredCodeword = nil
            self.lastDeliveredAt = .distantPast
        }
    }

    // MARK: - Private (on `queue`)

    private func startTaskOnQueue() {
        guard listening else { return }
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
        taskGeneration &+= 1
        let generation = taskGeneration
        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            guard let self else { return }
            self.queue.async {
                guard generation == self.taskGeneration else { return }
                if let result {
                    if !self.loggedFirstResult {
                        self.loggedFirstResult = true
                        print("[speech] recognition result received")
                    }
                    self.handleTranscriptionOnQueue(result.bestTranscription.formattedString)
                }
                if let error {
                    self.finishTaskOnQueue(generation: generation, message: error.localizedDescription)
                } else if result?.isFinal ?? false {
                    // On-device tasks end periodically; cycle a fresh one to keep
                    // listening continuously.
                    self.finishTaskOnQueue(generation: generation, message: "final result")
                }
            }
        }
        running = true
        loggedMissingRequest = false
        if !loggedTaskStarted {
            loggedTaskStarted = true
            print("[speech] recognition task started for locale \(recognizer.locale.identifier)")
        }
    }

    private func handleTranscriptionOnQueue(_ text: String) {
        // Scan only the last few spoken words so we react to a freshly-said
        // codeword rather than re-matching old transcript history.
        let words = text.lowercased()
            .split(whereSeparator: { !$0.isLetter })
            .suffix(4)
            .map(String.init)
        guard let match = words.reversed().first(where: { codewords.contains($0) }) else {
            return
        }

        let now = Date()
        if match == lastDeliveredCodeword, now.timeIntervalSince(lastDeliveredAt) < 2 {
            return
        }
        lastDeliveredCodeword = match
        lastDeliveredAt = now

        print("[speech] matched spoken codeword: \(match)")
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.speechCodewordListener(self, didHear: match)
        }
    }

    private func finishTaskOnQueue(generation: Int, message: String) {
        guard generation == taskGeneration else { return }
        task = nil
        request = nil
        running = false
        loggedMissingRequest = false

        if message.localizedCaseInsensitiveContains("no speech") {
            if !loggedNoSpeechRestart {
                loggedNoSpeechRestart = true
                print("[speech] no speech detected; keeping listener alive")
            }
            scheduleRestartOnQueue(after: 1.0)
        } else {
            print("[speech] recognition task ended: \(message); restarting")
            scheduleRestartOnQueue(after: 0.25)
        }
    }

    private func cancelTaskOnQueue() {
        taskGeneration &+= 1
        let oldTask = task
        task = nil
        request = nil
        running = false
        restartScheduled = false
        oldTask?.cancel()
    }

    private func scheduleRestartOnQueue(after delay: TimeInterval) {
        guard listening, !restartScheduled else { return }
        restartScheduled = true
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(delay * 1000))) { [weak self] in
            guard let self else { return }
            self.restartScheduled = false
            self.startTaskOnQueue()
        }
    }

    private static func copyBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else {
            return nil
        }
        copy.frameLength = buffer.frameLength

        let source = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
        let destination = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for index in 0..<min(source.count, destination.count) {
            guard let sourceData = source[index].mData,
                  let destinationData = destination[index].mData else {
                continue
            }
            let byteCount = min(Int(source[index].mDataByteSize), Int(destination[index].mDataByteSize))
            memcpy(destinationData, sourceData, byteCount)
            destination[index].mDataByteSize = UInt32(byteCount)
        }
        return copy
    }
}
