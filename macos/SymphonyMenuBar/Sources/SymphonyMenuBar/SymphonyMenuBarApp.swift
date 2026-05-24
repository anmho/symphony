import SwiftUI

@main
struct SymphonyMenuBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var statusService = StatusService()

    var body: some Scene {
        MenuBarExtra {
            menuContent
                .onAppear { statusService.start() }
                .onDisappear { statusService.stop() }
        } label: {
            menuBarLabel
        }
        .menuBarExtraStyle(.menu)
    }

    @ViewBuilder
    private var menuContent: some View {
        if let snapshot = statusService.snapshot, statusService.isOnline {
            let rows = snapshot.agentRows()
            if rows.isEmpty {
                Text("No agents yet.")
            } else {
                ForEach(rows.prefix(12)) { row in
                    Button {
                        statusService.openIssue(row.identifier)
                    } label: {
                        Text("\(row.identifier) — \(row.status)")
                    }
                }
                if rows.count > 12 {
                    Text("+\(rows.count - 12) more…")
                }
            }
            Divider()
        }

        if statusService.isOnline {
            Button("Stop Symphony") {
                statusService.stopSymphony()
            }
            .disabled(statusService.isBusy)
            if statusService.snapshot?.codexRateLimit.resumeAfterMs != nil {
                Button("Resume Rate-Limited Runs") {
                    statusService.resumeRateLimited()
                }
                .disabled(statusService.isBusy)
            }
        } else {
            Button("Start Symphony") {
                statusService.startSymphony()
            }
            .disabled(statusService.isBusy)
        }

        Button("Watch") {
            statusService.openWatch()
        }
        Button("Refresh Status") {
            statusService.refresh()
        }
        Button("Open Status Panel…") {
            StatusPanelController.shared.show(statusService: statusService)
        }
        Divider()
        Button("Quit Symphony") {
            NSApplication.shared.terminate(nil)
        }
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
