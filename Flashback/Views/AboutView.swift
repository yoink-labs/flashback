import SwiftUI

/// A small About sheet reached from the info button on Home: what Flashback
/// is, and the "Tip the devs" row.
struct AboutView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var tipping = false
    var openTipJarOnAppear = false

    private var version: String {
        let info = Bundle.main.infoDictionary
        let short = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Version \(short) (\(build))"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("About")
                        .font(.flTitle)
                        .foregroundStyle(Palette.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer()
                    Button("Done") { dismiss() }
                        .buttonStyle(.text)
                }
                Text("Flashback is a party game: whose camera roll is it? It's free with nothing locked, needs no account, and keeps nothing.")
                    .font(.flBody)
                    .foregroundStyle(Palette.text2)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 0) {
                    TipTheDevsRow { tipping = true }
                }
                .background(Palette.surface, in: RoundedRectangle(cornerRadius: Radius.media, style: .continuous))

                Text("Made by Yoink Labs · \(version)")
                    .font(.flCaption)
                    .foregroundStyle(Palette.text3)
            }
            .padding(20)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Palette.bg.ignoresSafeArea())
        .preferredColorScheme(.dark)
        .fontDesign(.rounded)
        .sheet(isPresented: $tipping) {
            TipJarView(store: .shared)
        }
        .onAppear { if openTipJarOnAppear { tipping = true } }
        .accessibilityIdentifier("about")
    }
}
