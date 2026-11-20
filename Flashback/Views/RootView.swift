import SwiftUI

struct RootView: View {
    @EnvironmentObject private var room: RoomStore
    var body: some View {
        ZStack {
            Palette.backdrop.ignoresSafeArea()
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
    }
}

struct ClosedView: View {
    @EnvironmentObject private var room: RoomStore
    var reason: String
    var body: some View {
        VStack(spacing: 16) {
            Image(systemName: reason == "removed" ? "door.left.hand.open" : "sparkles").font(.system(size: 54)).foregroundStyle(Palette.sun)
            Text(reason == "removed" ? "You left the room" : reason == "lost" ? "Connection lost" : "This room has closed").font(.title.bold())
            Text("Photos and videos from this room have been deleted.").foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button("Back to start") { room.dismissClosed() }.buttonStyle(.primary).frame(maxWidth: 320)
        }
        .padding(24)
    }
}
