//
//  HoldToTrigger.swift
//  SafeHaven — Disguise
//
//  Port of App.js's useHold + the H/L row Pressable. Holding the "H:24°  L:15°"
//  row for 3 seconds fires `onFire`. While held, the row background fills from
//  transparent → rgba(255,255,255,0.15) over the duration; releasing early
//  cancels and fades the fill back over 200ms. The label text is supplied by the
//  caller so this stays a pure interaction primitive.
//
//  This looks exactly like an inert high/low temperature label — there is no
//  visible affordance suggesting it is interactive.
//

import SwiftUI

struct HoldToTrigger<Label: View>: View {
    /// Fires after a continuous 3s hold (App.js durationMs = 3000).
    let onFire: () -> Void
    /// The label rendered inside the pressable row.
    @ViewBuilder var label: () -> Label

    private let duration: TimeInterval = 3.0
    private let cancelDuration: TimeInterval = 0.2   // App.js 200ms cancel fade

    @State private var progress: CGFloat = 0          // 0…1 fill
    @State private var isPressing = false
    @State private var fireWork: DispatchWorkItem?

    var body: some View {
        label()
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            .background(
                // transparent → rgba(255,255,255,0.15) (App.js bgColor interpolate)
                RoundedRectangle(cornerRadius: 20)
                    .fill(Color.white.opacity(0.15 * Double(progress)))
            )
            .contentShape(Rectangle())
            // A 0-distance drag gesture gives us press-in / press-out without a tap.
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { _ in
                        if !isPressing { begin() }
                    }
                    .onEnded { _ in
                        cancel()
                    }
            )
    }

    private func begin() {
        isPressing = true
        // Animate the fill to full over the hold duration.
        withAnimation(.linear(duration: duration)) {
            progress = 1
        }
        // Schedule the fire after the full duration.
        let work = DispatchWorkItem {
            // Reset fill instantly on fire (App.js progress.setValue(0)).
            progress = 0
            isPressing = false
            onFire()
        }
        fireWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: work)
    }

    private func cancel() {
        guard isPressing else { return }
        isPressing = false
        fireWork?.cancel()
        fireWork = nil
        // Fade the fill back over 200ms (App.js cancel animation).
        withAnimation(.linear(duration: cancelDuration)) {
            progress = 0
        }
    }
}
