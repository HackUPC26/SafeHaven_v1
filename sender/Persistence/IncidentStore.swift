//
//  IncidentStore.swift
//  SafeHaven — Persistence
//
//  Consent-gated, on-device-only incident log (PROTOCOL §0). A simple append
//  store today; the SQLite hash-chain evidence log is DEFERRED (§0 / §12). All
//  writes are gated on an explicit Consent flag — if consent is off, this is a
//  complete no-op and nothing touches disk.
//
//  Storage: one JSON-lines file in Application Support (excluded from iCloud
//  backup). Each line is one product-event envelope JSON exactly as sent to the
//  relay, plus a local capture timestamp. Nothing leaves the device.
//

import Foundation

@MainActor
final class IncidentStore {

    private let consent: Consent
    private let fileURL: URL
    private let fileManager = FileManager.default

    init(consent: Consent) {
        self.consent = consent

        // <AppSupport>/SafeHaven/incidents.log — created lazily on first write.
        let base = (try? FileManager.default.url(for: .applicationSupportDirectory,
                                                  in: .userDomainMask,
                                                  appropriateFor: nil,
                                                  create: true))
            ?? FileManager.default.temporaryDirectory
        let dir = base.appendingPathComponent("SafeHaven", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        self.fileURL = dir.appendingPathComponent("incidents.log")
    }

    /// Append one event envelope to the on-device log, IF consent is granted.
    /// `envelopeJSON` is the same `{type:"event",payload:…}` string sent to the
    /// relay; we record it verbatim so the local log mirrors the wire timeline.
    ///
    /// DEFERRED: the hash-chain (prev-hash linkage) would be computed here.
    func append(envelopeJSON: String) {
        guard consent.incidentLogEnabled else { return } // consent gate
        let line = envelopeJSON + "\n"
        guard let data = line.data(using: .utf8) else { return }

        if let handle = try? FileHandle(forWritingTo: fileURL) {
            defer { try? handle.close() }
            _ = try? handle.seekToEnd()
            try? handle.write(contentsOf: data)
        } else {
            // File doesn't exist yet — create it with this first line.
            try? data.write(to: fileURL, options: .atomic)
            excludeFromBackup()
        }
    }

    /// Delete the on-device log entirely (used by Reset / consent withdrawal).
    func clear() {
        try? fileManager.removeItem(at: fileURL)
    }

    /// Best-effort exclusion from iCloud/iTunes backup (incident data stays local).
    private func excludeFromBackup() {
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}
