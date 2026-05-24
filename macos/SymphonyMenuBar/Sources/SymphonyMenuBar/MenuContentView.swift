import AppKit
import SwiftUI
import SymphonyMenuBarCore

struct AgentRowView: View {
    let row: AgentRow
    let canOpenLinear: Bool
    let canOpenGitHub: Bool
    let openIssue: () -> Void
    let onOpenGitHub: () -> Void
    let onOpenLogs: () -> Void
    let onRetry: () -> Void

    var body: some View {
        Button(action: openIssue) {
            HStack(alignment: .top, spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(row.headline)
                            .font(.body.weight(.semibold))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                        if !canOpenLinear {
                            Image(systemName: "link.badge.plus")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                                .help("Set Linear org slug in Settings for ticket links")
                        }
                        Spacer()
                        Text(row.status)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(statusColor)
                    }
                    Text(row.detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                        .multilineTextAlignment(.leading)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if canOpenLinear {
                Button("Open in Linear") { openIssue() }
            }
            if canOpenGitHub {
                Button("Open GitHub Repo") { onOpenGitHub() }
            }
            if row.kind == .running || row.kind == .retry || row.kind == .parked {
                Button("Follow Logs") { onOpenLogs() }
                Button("Retry Now") { onRetry() }
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
            Text("Symphony Settings")
                .font(.headline)
            Stepper(value: $settings.statusPort, in: 1024 ... 65535) {
                Text("Status port: \(settings.statusPort)")
            }
            TextField("Linear org slug", text: $settings.linearOrgSlug)
            Stepper(value: $settings.pollIntervalSeconds, in: 2 ... 60) {
                Text("Poll every \(Int(settings.pollIntervalSeconds))s")
            }
            Toggle("Status change notifications", isOn: $settings.notificationsEnabled)
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
