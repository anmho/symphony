import SwiftUI

@main
struct SymphonyMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var statusService = StatusService()

    var body: some Scene {
        MenuBarExtra {
            SymphonyPanelView(service: statusService)
                .onAppear { statusService.start() }
                .onDisappear { statusService.stop() }
        } label: {
            menuBarLabel
        }
        .menuBarExtraStyle(.window)
    }

    private var menuBarLabel: some View {
        Image(systemName: menuBarSymbol)
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(menuBarTint)
            .help(menuBarHelp)
    }

    private var menuBarSymbol: String {
        if !statusService.isOnline {
            return "waveform.circle"
        }
        if (statusService.snapshot?.retryAttempts.count ?? 0) > 0 {
            return "waveform.circle.badge.exclamationmark"
        }
        if (statusService.snapshot?.running.count ?? 0) > 0 {
            return "waveform.circle.fill"
        }
        return "waveform.circle"
    }

    private var menuBarTint: Color {
        guard statusService.isOnline else { return .secondary }
        if (statusService.snapshot?.retryAttempts.count ?? 0) > 0 {
            return .orange
        }
        if (statusService.snapshot?.running.count ?? 0) > 0 {
            return .blue
        }
        return .primary
    }

    private var menuBarHelp: String {
        guard statusService.isOnline, let snapshot = statusService.snapshot else {
            return "Symphony offline"
        }
        let running = snapshot.running.count
        let retries = snapshot.retryAttempts.count
        if retries > 0 {
            return "Symphony: \(running) running, \(retries) retrying"
        }
        return "Symphony: \(running) running"
    }
}
