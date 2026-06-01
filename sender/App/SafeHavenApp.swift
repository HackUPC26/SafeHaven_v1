//
//  SafeHavenApp.swift
//  SafeHaven — App
//
//  Entry point. Owns the long-lived state objects (settings, consent, tier
//  controller) and presents the weather disguise as the sole UI. There is NO
//  launch-time permission prompt and NO visible safety surface — permissions are
//  requested in-context on tier escalation (PROTOCOL §5.3/§5.4 + the brief).
//

import SwiftUI

@main
struct SafeHavenApp: App {
    // Identity + config (Keychain-backed token/key, UserDefaults name/codewords).
    @StateObject private var settings = SettingsStore()
    // Consent gate for the on-device incident store (default OFF).
    @StateObject private var consent = Consent()
    // The tier state machine. Built once the dependencies exist.
    @StateObject private var tierController: TierController

    init() {
        // Construct the dependency graph. SettingsStore.load() runs in its init,
        // so token/key are available for the TierController's RelayClient.
        let settings = SettingsStore()
        let consent = Consent()
        _settings = StateObject(wrappedValue: settings)
        _consent = StateObject(wrappedValue: consent)
        _tierController = StateObject(wrappedValue: TierController(settings: settings, consent: consent))
    }

    var body: some Scene {
        WindowGroup {
            WeatherView(tierController: tierController,
                        settings: settings,
                        consent: consent)
        }
    }
}
