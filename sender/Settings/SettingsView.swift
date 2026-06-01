//
//  SettingsView.swift
//  SafeHaven — Settings
//
//  Hidden settings sheet (opened by a 2s long-press on "Barcelona" in the
//  disguise). Port of screens/SettingsScreen.js:
//   - Display name.
//   - Three codewords (validate: required + unique; stored trimmed + lowercased).
//   - Pairing QR code + selectable receiver URL.
//   - Relay host override (replaces EXPO_PUBLIC_SIGNAL_HOST).
//   - Reset (wipes settings + regenerates pairing).
//   - Consent toggle for the on-device incident store.
//
//  The dark "SafeHaven" chrome here is fine: it is only reachable via the hidden
//  gesture and is never visible during normal (disguised) use.
//

import SwiftUI
import CoreImage.CIFilterBuiltins

struct SettingsView: View {
    @ObservedObject var store: SettingsStore
    @ObservedObject var consent: Consent
    @Environment(\.dismiss) private var dismiss

    // Editable working copies.
    @State private var name: String = ""
    @State private var tier1: String = ""
    @State private var tier2: String = ""
    @State private var tier3: String = ""
    @State private var hostOverride: String = ""
    @State private var usesTLS: Bool = false

    @State private var saved = false
    @State private var validationError: String?
    @State private var showResetConfirm = false

    var body: some View {
        NavigationStack {
            Form {
                identitySection
                triggerWordsSection
                pairingSection
                relaySection
                consentSection
                dangerSection
            }
            .navigationTitle("SafeHaven")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .alert("Invalid codewords", isPresented: .constant(validationError != nil)) {
                Button("OK") { validationError = nil }
            } message: {
                Text(validationError ?? "")
            }
            .alert("Reset SafeHaven", isPresented: $showResetConfirm) {
                Button("Cancel", role: .cancel) {}
                Button("Reset", role: .destructive) {
                    store.reset()
                    loadFromStore()
                }
            } message: {
                Text("This will erase all settings and regenerate your pairing key. Are you sure?")
            }
            .onAppear(perform: loadFromStore)
        }
    }

    // MARK: - Sections

    private var identitySection: some View {
        Section("IDENTITY") {
            TextField("Your name (shown to receiver)", text: $name)
                .autocorrectionDisabled()
        }
    }

    private var triggerWordsSection: some View {
        Section {
            codewordRow(label: "Tier 1 — Audio + GPS", text: $tier1)
            codewordRow(label: "Tier 2 — Video", text: $tier2)
            codewordRow(label: "Tier 3 — Emergency", text: $tier3)
            Button(saved ? "Saved ✓" : "Save Settings") { handleSave() }
                .frame(maxWidth: .infinity)
                .fontWeight(.semibold)
        } header: {
            Text("TRIGGER WORDS")
        } footer: {
            Text("Type these into the search bar to escalate the alert tier. They should sound natural if overheard.")
        }
    }

    private func codewordRow(label: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField("codeword", text: text)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
    }

    private var pairingSection: some View {
        Section {
            HStack {
                Spacer()
                if let image = Self.qrImage(from: store.pairingURL) {
                    Image(uiImage: image)
                        .interpolation(.none)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 180, height: 180)
                }
                Spacer()
            }
            // Selectable so the operator can copy it verbatim into a browser.
            Text(store.pairingURL)
                .font(.system(.footnote, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .center)
        } header: {
            Text("TRUSTED CONTACT PAIRING")
        } footer: {
            Text("Share this QR code or link with your trusted contact to connect them to your dashboard.")
        }
    }

    private var relaySection: some View {
        Section {
            TextField("192.168.8.89:8080  or  relay.example.com", text: $hostOverride)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .keyboardType(.URL)
            Toggle("Use TLS (wss)", isOn: $usesTLS)
            Button("Apply relay settings") {
                RelayConfig.setHostOverride(hostOverride.isEmpty ? nil : hostOverride)
                RelayConfig.setTLSOverride(usesTLS)
            }
        } header: {
            Text("RELAY SERVER")
        } footer: {
            Text("Enter ONLY the relay's IP address (or hostname) and port — e.g. 192.168.8.89:8080. Do NOT include a scheme (http://, ws://) or any path (/ws); the app adds those itself. Leave blank to use the built-in default. Turn on TLS only if your relay serves wss://.")
        }
    }

    private var consentSection: some View {
        Section {
            Toggle("Keep an on-device incident log", isOn: Binding(
                get: { consent.incidentLogEnabled },
                set: { consent.incidentLogEnabled = $0 }
            ))
        } header: {
            Text("ON-DEVICE RECORD")
        } footer: {
            Text("When enabled, incident events are saved locally on this device only. Nothing is uploaded. Disabled by default.")
        }
    }

    private var dangerSection: some View {
        Section("DANGER ZONE") {
            Button("Reset Setup", role: .destructive) { showResetConfirm = true }
        }
    }

    // MARK: - Actions

    private func loadFromStore() {
        name = store.displayName
        tier1 = store.codewords.tier1
        tier2 = store.codewords.tier2
        tier3 = store.codewords.tier3
        hostOverride = UserDefaults.standard.string(forKey: "safehaven.relay.hostOverride") ?? ""
        usesTLS = RelayConfig.usesTLS
    }

    private func handleSave() {
        let cw = SettingsStore.Codewords(tier1: tier1, tier2: tier2, tier3: tier3)
        if let err = SettingsStore.validate(name: name, codewords: cw) {
            validationError = err
            return
        }
        store.save(name: name, codewords: cw)
        // Reflect the cleaned (trimmed/lowercased) values back into the fields.
        tier1 = store.codewords.tier1
        tier2 = store.codewords.tier2
        tier3 = store.codewords.tier3
        saved = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { saved = false }
    }

    // MARK: - QR generation (CoreImage; no third-party deps)

    private static func qrImage(from string: String) -> UIImage? {
        let context = CIContext()
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        // Scale up so the QR is crisp at 180pt.
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
