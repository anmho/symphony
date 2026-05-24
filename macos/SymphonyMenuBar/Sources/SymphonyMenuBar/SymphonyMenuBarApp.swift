import SwiftUI

@main
struct SymphonyMenuBarApp: App {
    @StateObject private var statusService = StatusService()

    var body: some Scene {
        MenuBarExtra {
            MenuContentView(service: statusService)
                .onAppear { statusService.start() }
                .onDisappear { statusService.stop() }
        } label: {
            menuBarLabel
        }
        .menuBarExtraStyle(.window)
    }

    @ViewBuilder
    private var menuBarLabel: some View {
        let running = statusService.snapshot?.running.count ?? 0
        let retries = statusService.snapshot?.retryAttempts.count ?? 0
        if statusService.isOnline {
            if retries > 0 {
                Text("♫ \(running)/\(retries)")
            } else {
                Text("♫ \(running)")
            }
        } else {
            Image(systemName: "waveform.circle")
        }
    }
}
