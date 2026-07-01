//
//  CodewordField.swift
//  SafeHaven — Disguise
//
//  Port of App.js's hidden codeword TextInput ("Search weather..."). Looks like
//  an ordinary search field; on EVERY keystroke it forwards the raw text to the
//  tier controller, which lowercases + trims and applies the direct-to-tier codeword
//  rules. Clears after a consumed codeword so the next typed codeword starts
//  from an empty field. Styled to blend into the weather gradient.
//

import SwiftUI

struct CodewordField: View {
    /// Called on every change with the raw field text. Returns true if a
    /// codeword was consumed and the search text should reset.
    let onChange: (String) -> Bool

    @State private var text: String = ""

    var body: some View {
        TextField("", text: $text, prompt: Text("Search weather...")
            .foregroundColor(.white.opacity(0.4)))
            .foregroundStyle(.white)
            .font(.system(size: 14))
            .multilineTextAlignment(.center)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .frame(width: 160)
            .padding(.bottom, 4)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(Color.white.opacity(0.3))
                    .frame(height: 1)
            }
            .padding(.top, 8)
            .onChange(of: text) { _, newValue in
                if onChange(newValue) {
                    text = ""
                }
            }
    }
}
