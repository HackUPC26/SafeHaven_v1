//
//  SoundClassifier.swift
//  SafeHaven — AI
//
//  VERBATIM port of mobile/modules/safe-haven-ai/ios/SafeHavenAIModule.swift,
//  decoupled from Expo. PROTOCOL §5.3 requires the constants, the full
//  safeHavenLabel(for:) mapping, normalizeIdentifier, handleClassifications
//  semantics, and the silence/duplicate logic to be reproduced EXACTLY.
//
//  Architectural change from the legacy module (PROTOCOL §5.4): there is exactly
//  ONE AVAudioEngine in the app (owned by CaptureCoordinator). This classifier
//  therefore does NOT create its own engine or install its own tap — it owns the
//  SNAudioStreamAnalyzer and the classification request, and is fed mic buffers
//  by CaptureCoordinator via `analyze(buffer:atFramePosition:)`. The analyzer is
//  (re)created when the input format is known via `prepare(format:)`. Everything
//  downstream of the analyzer — the observer, the 0.60 threshold, 2.0s per-label
//  duplicate suppression, 5.0s extended-silence timer, the mapping table, and
//  confidence clamping — is identical to the legacy module.
//

import Foundation
import AVFoundation
import SoundAnalysis

// MARK: - Constants (verbatim from the legacy module / PROTOCOL §5.3)

private let confidenceThreshold = 0.60
private let duplicateSuppressionSeconds = 2.0
private let extendedSilenceSeconds = 5.0

/// Emits an ai_label for a mapped, above-threshold classification. The label is
/// one of the 9 valid labels; confidence is clamped to [0,1] by the caller path.
protocol SoundClassifierDelegate: AnyObject {
    func soundClassifier(_ classifier: SoundClassifier,
                         didEmitLabel label: String,
                         confidence: Double,
                         rawIdentifier: String)
}

final class SoundClassifier {

    weak var delegate: SoundClassifierDelegate?

    /// Serial queue (legacy label preserved).
    private let analysisQueue = DispatchQueue(label: "safehaven.ai.sound-analysis")

    private var analyzer: SNAudioStreamAnalyzer?
    private var classifyRequest: SNClassifySoundRequest?
    private var observer: SafeHavenSoundObserver?
    private var isRunning = false

    private var silenceStartedAt: Date?
    private var lastEmittedAtByLabel: [String: Date] = [:]

    /// Whether SoundAnalysis is usable here (false on the simulator). Mirrors the
    /// legacy `soundClassificationAvailable`.
    static var isAvailable: Bool {
        #if targetEnvironment(simulator)
        return false
        #else
        return true   // iOS 17 target; SNClassifySoundRequest(.version1) is present
        #endif
    }

    // MARK: - Lifecycle

    /// Build the analyzer for the given input format and arm the classifier.
    /// Called by CaptureCoordinator once the shared engine's input format is
    /// known (analogous to the legacy `startEngine()` analyzer setup, minus the
    /// engine/tap which the coordinator now owns).
    func prepare(format: AVAudioFormat) {
        analysisQueue.async { [weak self] in
            guard let self else { return }
            guard Self.isAvailable else {
                print("[SafeHavenAI] SoundAnalysis is unavailable on this device")
                return
            }
            if self.isRunning { return }

            do {
                let analyzer = SNAudioStreamAnalyzer(format: format)
                let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
                request.overlapFactor = 0.5
                let observer = SafeHavenSoundObserver(owner: self)
                try analyzer.add(request, withObserver: observer)

                self.analyzer = analyzer
                self.classifyRequest = request
                self.observer = observer
                self.silenceStartedAt = nil
                self.lastEmittedAtByLabel = [:]
                self.isRunning = true
            } catch {
                print("[SafeHavenAI] Failed to start sound classification: \(error.localizedDescription)")
                self.teardownOnQueue()
            }
        }
    }

    /// Feed a mic buffer from the shared engine's tap into the analyzer. Hops to
    /// the analysis queue exactly as the legacy tap closure did.
    func analyze(buffer: AVAudioPCMBuffer, atFramePosition framePosition: AVAudioFramePosition) {
        analysisQueue.async { [weak self] in
            self?.analyzer?.analyze(buffer, atAudioFramePosition: framePosition)
        }
    }

    /// Stop and release the analyzer (analogous to legacy stopSoundClassification).
    func stop() {
        analysisQueue.async { [weak self] in
            self?.teardownOnQueue()
        }
    }

    private func teardownOnQueue() {
        analyzer?.removeAllRequests()
        analyzer = nil
        classifyRequest = nil
        observer = nil
        silenceStartedAt = nil
        lastEmittedAtByLabel = [:]
        isRunning = false
    }

    // MARK: - Classification pipeline (verbatim semantics, §5.3)

    fileprivate func handleClassifications(_ classifications: [SNClassification]) {
        guard let topClassification = classifications.first else {
            return
        }

        let topIdentifier = normalizeIdentifier(topClassification.identifier)
        // Check ONLY the top classification for silence.
        if topIdentifier == "silence" {
            handleSilence(rawIdentifier: topClassification.identifier,
                          confidence: topClassification.confidence)
            return
        }

        silenceStartedAt = nil

        // Emit the FIRST classification that is >= 0.60 AND maps to a label.
        for classification in classifications {
            let normalizedIdentifier = normalizeIdentifier(classification.identifier)
            guard classification.confidence >= confidenceThreshold,
                  let label = safeHavenLabel(for: normalizedIdentifier) else {
                continue
            }
            emitLabel(label, confidence: classification.confidence,
                      rawIdentifier: classification.identifier)
            return
        }
    }

    fileprivate func handleSoundAnalysisFailure(_ error: Error) {
        print("[SafeHavenAI] SoundAnalysis request failed: \(error.localizedDescription)")
        stop()
    }

    fileprivate func handleSoundAnalysisCompletion() {
        stop()
    }

    private func handleSilence(rawIdentifier: String, confidence: Double) {
        guard confidence >= confidenceThreshold else {
            silenceStartedAt = nil
            return
        }

        let now = Date()
        if silenceStartedAt == nil {
            silenceStartedAt = now
            return
        }

        guard let startedAt = silenceStartedAt,
              now.timeIntervalSince(startedAt) >= extendedSilenceSeconds else {
            return
        }

        emitLabel("EXTENDED_SILENCE", confidence: confidence, rawIdentifier: rawIdentifier)
    }

    private func emitLabel(_ label: String, confidence: Double, rawIdentifier: String) {
        let now = Date()
        // Per-label duplicate suppression (2.0s).
        if let lastEmittedAt = lastEmittedAtByLabel[label],
           now.timeIntervalSince(lastEmittedAt) < duplicateSuppressionSeconds {
            return
        }
        lastEmittedAtByLabel[label] = now

        // Clamp confidence to [0,1] before emitting (PROTOCOL §5.3).
        let clamped = min(1.0, max(0.0, confidence))

        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.delegate?.soundClassifier(self,
                                           didEmitLabel: label,
                                           confidence: clamped,
                                           rawIdentifier: rawIdentifier)
        }
    }

    // MARK: - Identifier mapping (verbatim from the legacy module)

    private func normalizeIdentifier(_ identifier: String) -> String {
        return identifier
            .lowercased()
            .replacingOccurrences(of: " ", with: "_")
            .replacingOccurrences(of: "-", with: "_")
    }

    private func safeHavenLabel(for identifier: String) -> String? {
        if identifier == "shout" ||
            identifier == "yell" ||
            identifier == "children_shouting" ||
            identifier.contains("shout") ||
            identifier.contains("yell") {
            return "SHOUTING"
        }

        if identifier == "screaming" ||
            identifier == "battle_cry" ||
            identifier.contains("scream") {
            return "SCREAMING"
        }

        if identifier == "crying_sobbing" ||
            identifier == "baby_crying" ||
            identifier.contains("crying") ||
            identifier.contains("sobbing") {
            return "CRYING"
        }

        // Apple's `gunshot_gunfire` class is surfaced as a generic loud IMPACT,
        // NOT a firearm claim. SafeHaven deliberately does not predict gunshots
        // — that is unreliable and unsafe to assert — but a loud bang is still a
        // real danger signal worth flagging as a loud impact.
        if identifier == "thump_thud" ||
            identifier == "crushing" ||
            identifier == "boom" ||
            identifier == "hammer" ||
            identifier == "knock" ||
            identifier == "tap" ||
            identifier == "wood_cracking" ||
            identifier == "chopping_wood" ||
            identifier == "gunshot_gunfire" {
            return "IMPACT"
        }

        if identifier == "slap_smack" {
            return "SLAP"
        }

        if identifier == "door_slam" {
            return "DOOR_SLAM"
        }

        if identifier == "glass_breaking" ||
            identifier == "glass_clink" {
            return "GLASS_BREAKING"
        }

        return nil
    }
}

// MARK: - SNResultsObserving (verbatim from the legacy module)

private final class SafeHavenSoundObserver: NSObject, SNResultsObserving {
    private weak var owner: SoundClassifier?

    init(owner: SoundClassifier) {
        self.owner = owner
    }

    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult,
              !result.classifications.isEmpty else {
            return
        }
        owner?.handleClassifications(result.classifications)
    }

    func request(_ request: SNRequest, didFailWithError error: Error) {
        owner?.handleSoundAnalysisFailure(error)
    }

    func requestDidComplete(_ request: SNRequest) {
        owner?.handleSoundAnalysisCompletion()
    }
}
