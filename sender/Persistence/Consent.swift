//
//  Consent.swift
//  SafeHaven — Persistence
//
//  Explicit consent flag gating the on-device incident store (PROTOCOL §0 /
//  decision row "On-device persistence" — consent-gated local incident store).
//  Default OFF; the user opts in from the hidden Settings screen. Per CLAUDE.md:
//  "Do not store incident data … without explicit user consent."
//

import Foundation

@MainActor
final class Consent: ObservableObject {

    private static let key = "safehaven.consent.incidentLog"

    /// When true, IncidentStore is permitted to write events to disk.
    @Published var incidentLogEnabled: Bool {
        didSet { UserDefaults.standard.set(incidentLogEnabled, forKey: Self.key) }
    }

    init() {
        // Defaults to false (no key present → false).
        incidentLogEnabled = UserDefaults.standard.bool(forKey: Self.key)
    }
}
