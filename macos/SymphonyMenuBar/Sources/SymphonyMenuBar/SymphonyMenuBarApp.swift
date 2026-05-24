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
        HStack(spacing: 3) {
            Image(systemName: menuBarSymbol)
                .symbolRenderingMode(.hierarchical)
            if let badge = menuBarBadge {
                Text(badge)
                    .font(.system(size: 11, weight: .semibold, design: .rounded))
            }
        }
        .foregroundStyle(menuBarTint)
        .help(menuBarHelp)
    }

    private var menuBarBadge: String? {
        guard statusService.isOnline, let snapshot = statusService.snapshot else {
            return nil
        }
        if snapshot.paused {
            return "⏸"
        }
        let inventory = snapshot.agentInventory()
        guard inventory.active > 0 else { return nil }
        if inventory.queued > 0, inventory.running > 0 {
            return "\(inventory.active)"
        }
        if inventory.queued > 0 {
            return "\(inventory.queued)"
        }
        return "\(inventory.running)"
    }

    private var menuBarSymbol: String {
        if !statusService.isOnline {
            return "waveform.circle"
        }
        if statusService.snapshot?.paused == true {
            return "pause.circle.fill"
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
        guard statusService.isOnline else { return .primary.opacity(0.55) }
        if statusService.snapshot?.paused == true {
            return .orange
        }
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
        if snapshot.paused {
            return "Symphony: dispatch paused"
        }
        let inventory = snapshot.agentInventory()
        if inventory.active == 0 {
            return "Symphony: idle"
        }
        if inventory.queued > 0 {
            return "Symphony: \(inventory.running) running, \(inventory.queued) queued (\(inventory.active) active)"
        }
        return "Symphony: \(inventory.running) running"
    }
}
