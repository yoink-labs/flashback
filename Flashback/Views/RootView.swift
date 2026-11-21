import SwiftUI

struct RootView: View {
    @EnvironmentObject private var room: RoomStore

    var body: some View {
        ZStack {
            Palette.bg.ignoresSafeArea()
            if case .closed(let reason) = room.connection {
                ClosedView(reason: reason)
            } else if room.session != nil {
                RoomScreen()
            } else {
                HomeView()
            }
        }
        .preferredColorScheme(.dark)
        .fontDesign(.rounded)
        .tint(Palette.accent)
    }
}

struct ClosedView: View {
    @EnvironmentObject private var room: RoomStore
    var reason: String

    var body: some View {
        VStack(spacing: 12) {
            Spacer(minLength: 0)
            Text(title)
                .font(.flTitle)
                .foregroundStyle(Palette.text)
                .multilineTextAlignment(.center)
            Text("Nothing from this room is kept.")
                .font(.flBody)
                .foregroundStyle(Palette.text2)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
            Button("Back to start") { room.dismissClosed() }
                .buttonStyle(.primary)
                .frame(maxWidth: 360)
        }
        .padding(Spacing.pageCompact)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var title: String {
        switch reason {
        case "removed": "You left the room"
        case "lost": "Connection lost"
        default: "This room has closed"
        }
    }
}
