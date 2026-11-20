import ClerkKit
import SwiftUI

@main struct FlashbackApp: App {
    @StateObject private var room = RoomStore()
    @StateObject private var account = AccountStore()
    @Environment(\.scenePhase) private var phase
    // Same shared Yoink Labs publishable key as Split. Sign-in is optional.
    init() { Clerk.configure(publishableKey: "pk_live_Y2xlcmsueW9pbmtsYWJzLmRldiQ") }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(room)
                .environmentObject(account)
                .tint(Palette.accent)
                .task { await account.restore() }
                .task { room.resume() }
                .onOpenURL { room.open(url: $0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { if let url = $0.webpageURL { room.open(url: url) } }
                .onChange(of: phase) { _, new in
                    if new == .active, room.session != nil, room.connection != .open { room.connect() }
                }
        }
    }
}
