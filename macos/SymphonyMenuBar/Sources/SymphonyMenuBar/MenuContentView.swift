import AppKit
import SwiftUI
import SymphonyMenuBarCore

struct MenuContentView: View {
    @ObservedObject var service: StatusService
    @State private var showSettings = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            summary
            Divider()
            agentList
            Divider()
            footer
        }
        .padding(14)
        .frame(width: 360)
        .sheet(isPresented: $showSettings) {
            SettingsView(settings: service.settings) { updated in
                service.settings = updated
                updated.save()
                service.start()
            }
        }
        .alert("Symphony CLI", isPresented: actionErrorPresented) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(service.actionError ?? "")
        }
    }

    private var actionErrorPresented: Binding<Bool> {
        Binding(
            get: { service.actionError != nil },
            set: { isPresented in
                if !isPresented {
                    service.actionError = nil
                }
            }
        )
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Symphony")
                    .font(.headline)
                Text(service.isOnline ? "Connected" : "Offline")
                    .font(.caption)
                    .foregroundStyle(service.isOnline ? .green : .secondary)
            }
            Spacer()
            Button {
                showSettings = true
            } label: {
                Image(systemName: "gearshape")
            }
            .buttonStyle(.plain)
        }
    }

    private var summary: some View {
        let running = service.snapshot?.running.count ?? 0
        let retries = service.snapshot?.retryAttempts.count ?? 0
        let completed = service.snapshot?.completed.count ?? 0
        let rateLimited = service.snapshot?.codexRateLimit.resumeAfterMs != nil

        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                statPill("Running", value: running, color: .green)
                statPill("Retries", value: retries, color: retries > 0 ? .orange : .secondary)
                statPill("Done", value: completed, color: .blue)
            }
            if rateLimited {
                Label("Codex rate limited", systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
            if let error = service.lastError, !service.isOnline {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if let configError = service.snapshot?.lastConfigError, !configError.isEmpty {
                Text(configError)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
    }

    private var agentList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if let snapshot = service.snapshot {
                    let rows = snapshot.agentRows()
                    if rows.isEmpty {
                        Text("No agents yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(rows) { row in
                            AgentRowView(row: row) {
                                service.openIssue(row.identifier)
                            } onOpenLogs: {
                                service.openLogs(for: row.identifier)
                            }
                        }
                    }
                } else {
                    Text("Start Symphony with `symphony start`.")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxHeight: 320)
    }

    private var footer: some View {
        HStack {
            Text("Updated \(service.lastUpdated.formatted(date: .omitted, time: .standard))")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            Button("Refresh") { service.refresh() }
            Button("Watch") { service.openWatch() }
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .buttonStyle(.link)
    }

    private func statPill(_ title: String, value: Int, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text("\(value)")
                .font(.title3.weight(.semibold))
                .foregroundStyle(color)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(Color.primary.opacity(0.05))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

struct AgentRowView: View {
    let row: AgentRow
    let openIssue: () -> Void
    let onOpenLogs: () -> Void

    var body: some View {
        Button(action: openIssue) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Text(row.identifier)
                            .font(.body.weight(.semibold))
                        Spacer()
                        Text(row.status)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(statusColor)
                    }
                    Text(row.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Open in Linear") { openIssue() }
            if row.kind == .running || row.kind == .retry || row.kind == .parked {
                Button("Follow Logs") { onOpenLogs() }
            }
        }
    }

    private var statusColor: Color {
        switch row.kind {
        case .running: return .green
        case .retry: return .orange
        case .parked: return .yellow
        case .completed: return .blue
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State var settings: AppSettings
    let onSave: (AppSettings) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Symphony Menu Bar Settings")
                .font(.headline)
            Stepper(value: $settings.statusPort, in: 1024 ... 65535) {
                Text("Status port: \(settings.statusPort)")
            }
            TextField("Linear org slug", text: $settings.linearOrgSlug)
            Stepper(value: $settings.pollIntervalSeconds, in: 2 ... 60) {
                Text("Poll every \(Int(settings.pollIntervalSeconds))s")
            }
            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    onSave(settings)
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 320)
    }
}
