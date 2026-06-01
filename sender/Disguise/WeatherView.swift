//
//  WeatherView.swift
//  SafeHaven — Disguise
//
//  The covert disguise: a Barcelona weather app. Faithful SwiftUI port of
//  App.js's render tree and styles. Verbatim content per the brief:
//   - "Barcelona" / "22°" / "Mostly Sunny"
//   - gradient ['#1a6da8','#3a9fd6','#6ac4ee','#a8dff5']
//   - 8 hourly entries, 8 daily entries under "10-DAY FORECAST"
//   - 4 mini-cards (HUMIDITY / VISIBILITY / WIND / UV INDEX)
//   - "UV INDEX 6 · FEELS LIKE 24°" label above the hourly strip
//
//  Hidden interactions (no visible safety UI beyond the StatusDot):
//   - 2s long-press on "Barcelona" → hidden Settings sheet.
//   - 3s hold on the "H:24°  L:15°" row → SOS trigger (HoldToTrigger).
//   - "Search weather..." field → codeword detection on every keystroke.
//   - SOS "sent flash": a green dot for 1200ms after a successful hold.
//

import SwiftUI

// Hourly strip data (App.js HOURS).
private let HOURS: [(t: String, i: String, c: Int)] = [
    ("Now", "☀️", 22), ("13h", "🌤", 23), ("14h", "⛅", 23),
    ("15h", "🌥", 21), ("16h", "⛅", 20), ("17h", "☀️", 20),
    ("18h", "🌇", 18), ("19h", "🌙", 16),
]

// 10-day data (App.js DAYS).
private let DAYS: [(d: String, i: String, lo: Int, hi: Int)] = [
    ("Today", "☀️", 15, 23), ("Wed", "🌤", 14, 22),
    ("Thu", "⛅", 13, 20), ("Fri", "🌧", 12, 17),
    ("Sat", "🌦", 14, 19), ("Sun", "☀️", 16, 24),
    ("Mon", "☀️", 17, 26), ("Tue", "🌤", 15, 24),
]

// Mini-card grid (App.js grid).
private let MINI_CARDS: [(l: String, v: String, s: String)] = [
    ("HUMIDITY", "62%", "Dew point 14°"),
    ("VISIBILITY", "24 km", "Perfectly clear"),
    ("WIND", "14 km/h", "NE — sea breeze"),
    ("UV INDEX", "6", "High. Wear sunscreen"),
]

struct WeatherView: View {
    @ObservedObject var tierController: TierController
    @ObservedObject var settings: SettingsStore
    @ObservedObject var consent: Consent

    @State private var settingsOpen = false
    @State private var showSentFlash = false

    private let gradient = LinearGradient(
        colors: [
            Color(hex: 0x1a6da8), Color(hex: 0x3a9fd6),
            Color(hex: 0x6ac4ee), Color(hex: 0xa8dff5),
        ],
        startPoint: .top, endPoint: .bottom
    )

    var body: some View {
        ZStack(alignment: .topTrailing) {
            gradient.ignoresSafeArea()

            ScrollView(showsIndicators: false) {
                VStack(spacing: 0) {
                    Color.clear.frame(height: 60)   // topPad

                    header

                    codewordField

                    hourlyCard

                    forecastCard

                    miniGrid

                    Color.clear.frame(height: 48)   // bottomPad
                }
            }

            // Tiny status dot (orange T1/T2, red T3), only when tier > 0.
            StatusDot(tier: tierController.tier)
                .padding(.top, 60)
                .padding(.trailing, 20)

            // Silent "sent" flash — a green dot for 1200ms after a hold fires.
            if showSentFlash {
                Circle()
                    .fill(Color(red: 0, green: 1, blue: 120/255).opacity(0.9))
                    .frame(width: 10, height: 10)
                    .position(x: UIScreen.main.bounds.width * 0.5,
                              y: UIScreen.main.bounds.height * 0.45)
                    .accessibilityHidden(true)
            }
        }
        .sheet(isPresented: $settingsOpen) {
            SettingsView(store: settings, consent: consent)
        }
        .preferredColorScheme(.light)
    }

    // MARK: - Header (city / temp / desc / H-L hold row)

    private var header: some View {
        VStack(spacing: 0) {
            // 2s long-press on "Barcelona" opens hidden settings (App.js).
            Text("Barcelona")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white)
                .onLongPressGesture(minimumDuration: 2.0) {
                    settingsOpen = true
                }

            Text("22°")
                .font(.system(size: 96, weight: .ultraLight))
                .foregroundStyle(.white)
                .frame(height: 100)

            Text("Mostly Sunny")
                .font(.system(size: 20))
                .foregroundStyle(.white.opacity(0.9))

            // H/L row — 3s hold SOS trigger.
            HoldToTrigger(onFire: handleHoldFire) {
                Text("H:24°  L:15°")
                    .font(.system(size: 18))
                    .foregroundStyle(.white.opacity(0.85))
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
    }

    private var codewordField: some View {
        CodewordField(onChange: tierController.handleCodewordInput)
    }

    // MARK: - Cards

    private var hourlyCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("UV INDEX 6 · FEELS LIKE 24°")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.8))
                    .kerning(0.3)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) {
                        ForEach(HOURS.indices, id: \.self) { i in
                            VStack(spacing: 6) {
                                Text(HOURS[i].t).font(.system(size: 15)).foregroundStyle(.white.opacity(0.9))
                                Text(HOURS[i].i).font(.system(size: 22))
                                Text("\(HOURS[i].c)°").font(.system(size: 15)).foregroundStyle(.white)
                            }
                            .frame(width: 52)
                            .padding(.horizontal, 2)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
    }

    private var forecastCard: some View {
        GlassCard {
            VStack(alignment: .leading, spacing: 0) {
                Text("10-DAY FORECAST")
                    .font(.system(size: 13))
                    .foregroundStyle(.white.opacity(0.8))
                    .kerning(0.3)
                    .padding(.bottom, 10)
                ForEach(DAYS.indices, id: \.self) { i in
                    HStack {
                        Text(DAYS[i].d)
                            .font(.system(size: 17, weight: .medium))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Text(DAYS[i].i).font(.system(size: 22)).padding(.trailing, 12)
                        Text("\(DAYS[i].lo)°")
                            .font(.system(size: 17))
                            .foregroundStyle(.white.opacity(0.65))
                            .padding(.trailing, 10)
                        Capsule()
                            .fill(Color.white.opacity(0.6))
                            .frame(width: 80, height: 5)
                            .padding(.trailing, 10)
                        Text("\(DAYS[i].hi)°").font(.system(size: 17)).foregroundStyle(.white)
                    }
                    .padding(.vertical, 10)
                    .overlay(alignment: .top) {
                        if i > 0 {
                            Rectangle().fill(Color.white.opacity(0.2)).frame(height: 0.5)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
    }

    private var miniGrid: some View {
        // 2-column grid of 4 mini-cards (App.js grid width '47%').
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)], spacing: 10) {
            ForEach(MINI_CARDS.indices, id: \.self) { i in
                GlassCard {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(MINI_CARDS[i].l)
                            .font(.system(size: 12))
                            .foregroundStyle(.white.opacity(0.7))
                            .kerning(0.5)
                        Text(MINI_CARDS[i].v)
                            .font(.system(size: 28, weight: .medium))
                            .foregroundStyle(.white)
                        Text(MINI_CARDS[i].s)
                            .font(.system(size: 13))
                            .foregroundStyle(.white.opacity(0.75))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 10)
    }

    // MARK: - Hold fire

    private func handleHoldFire() {
        // Silent sent flash for 1200ms (App.js sent state).
        showSentFlash = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { showSentFlash = false }
        tierController.handleHold()
    }
}

// MARK: - Glass card (App.js `glass` style)

private struct GlassCard<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 18)
                    .fill(Color.white.opacity(0.18))
                    .overlay(
                        RoundedRectangle(cornerRadius: 18)
                            .stroke(Color.white.opacity(0.3), lineWidth: 0.5)
                    )
            )
    }
}

// MARK: - Hex color helper

extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(red: r, green: g, blue: b)
    }
}
