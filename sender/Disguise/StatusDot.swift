//
//  StatusDot.swift
//  SafeHaven — Disguise
//
//  The single subtle status indicator allowed by the disguise (App.js styles.dot
//  + dotOrange/dotRed). Shown ONLY when tier > 0: orange for T1/T2, red for T3.
//  No other safety UI is ever surfaced.
//

import SwiftUI

struct StatusDot: View {
    let tier: Int

    var body: some View {
        // Only visible while a session is active (tier > 0), matching App.js.
        if tier > 0 {
            Circle()
                .fill(tier == 3 ? Color.red : Color.orange)
                .frame(width: 8, height: 8)
                .accessibilityHidden(true)   // invisible to VoiceOver — stays covert
        }
    }
}
