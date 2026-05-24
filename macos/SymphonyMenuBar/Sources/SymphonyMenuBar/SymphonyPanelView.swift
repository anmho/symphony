import AppKit
import SwiftUI
import SymphonyMenuBarCore

enum PanelSection: String, CaseIterable, Identifiable {
    case overview
    case running
    case waiting
    case done
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .running: return "Running"
        case .waiting: return "Waiting"
        case .done: return "Done"
        case .settings: return "Settings"
        }
    }

    var symbol: String {
        switch self {
        case .overview: return "waveform.circle.fill"
        case .running: return "play.circle.fill"
        case .waiting: return "pause.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .settings: return "gearshape.fill"
        }
    }
}

struct SymphonyPanelView: View {
    @ObservedObject var service: StatusService
    @State private var section: PanelSection = .overview

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            Divider()
            mainContent
        }
        .frame(width: 440, height: 500)
        .background(Color(nsColor: .windowBackgroundColor))
        .alert("Symphony", isPresented: actionErrorPresented) {
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

    private var sidebar: some View {
        VStack(spacing: 6) {
            ForEach(PanelSection.allCases) { item in
                sidebarButton(item)
            }
            Spacer()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 8)
        .frame(width: 52)
        .background(Color.primary.opacity(0.04))
    }

    private func sidebarButton(_ item: PanelSection) -> some View {
        Button {
            section = item
        } label: {
            ZStack(alignment: .topTrailing) {
                Image(systemName: item.symbol)
                    .font(.system(size: 18))
                    .frame(width: 36, height: 36)
                    .foregroundStyle(section == item ? Color.accentColor : Color.secondary)
                    .background(
                        RoundedRectangle(cornerRadius: 8)
                            .fill(section == item ? Color.accentColor.opacity(0.15) : Color.clear)
                    )
                if let count = sidebarCount(for: item), count > 0 {
                    Text("\(count)")
                        .font(.system(size: 9, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(3)
                        .background(Circle().fill(Color.orange))
                        .offset(x: 4, y: -2)
                }
            }
        }
        .buttonStyle(.plain)
        .help(item.title)
    }

    private func sidebarCount(for item: PanelSection) -> Int? {
        guard let snapshot = service.snapshot, service.isOnline else { return nil }
        let inventory = snapshot.agentInventory()
        switch item {
        case .overview:
            return inventory.active > 0 ? inventory.active : nil
        case .running:
            return inventory.running > 0 ? inventory.running : nil
        case .waiting:
            let queued = inventory.queued
            return queued > 0 ? queued : nil
        case .done:
            return inventory.completed > 0 ? inventory.completed : nil
        default:
            return nil
        }
    }

    @ViewBuilder
    private var mainContent: some View {
        VStack(alignment: .leading, spacing: 0) {
            panelHeader
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch section {
                    case .overview:
                        overviewContent
                    case .running, .waiting, .done:
                        agentSectionContent
                    case .settings:
                        settingsContent
                    }
                }
                .padding(16)
            }
            Divider()
            panelFooter
        }
    }

    private var sectionTitle: String {
        guard let snapshot = service.snapshot, service.isOnline else {
            return section.title
        }
        let inventory = snapshot.agentInventory()
        switch section {
        case .overview:
            return inventory.active > 0 ? "Overview · \(inventory.active) active" : section.title
        case .running:
            return inventory.running > 0 ? "Running · \(inventory.running)" : section.title
        case .waiting:
            return inventory.queued > 0 ? "Waiting · \(inventory.queued)" : section.title
        case .done:
            return inventory.completed > 0 ? "Done · \(inventory.completed)" : section.title
        case .settings:
            return section.title
        }
    }

    private var panelHeader: some View {
        HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Text("Symphony")
                        .font(.title3.weight(.semibold))
                    statusBadge
                }
                Text(sectionTitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            headerActions
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var statusBadge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(service.isOnline ? Color.green : Color.secondary)
                .frame(width: 7, height: 7)
            Text(service.isOnline ? "Live" : "Offline")
                .font(.caption2.weight(.medium))
                .foregroundStyle(service.isOnline ? .green : .secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.primary.opacity(0.06)))
    }

    private var headerActions: some View {
        HStack(spacing: 8) {
            if service.isOnline {
                Button("Stop") { service.stopSymphony() }
                    .disabled(service.isBusy)
            } else {
                Button("Start") { service.startSymphony() }
                    .disabled(service.isBusy)
            }
            Button {
                service.openWatch()
            } label: {
                Label("Watch", systemImage: "terminal")
            }
            Button {
                service.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help("Refresh")
        }
        .buttonStyle(.bordered)
        .controlSize(.small)
    }

    private var overviewContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let message = service.actionMessage {
                infoBanner(message, color: .blue)
            }

            if !service.isOnline, let error = service.lastError {
                infoBanner(error, color: .secondary)
            }

            if let snapshot = service.snapshot, service.isOnline {
                let inventory = snapshot.agentInventory()

                metricCard(
                    title: "Active agents",
                    value: "\(inventory.active)",
                    subtitle: activeAgentsSubtitle(inventory),
                    progress: progressFraction(active: inventory.active, total: max(inventory.active + inventory.completed, 1)),
                    tint: .primary
                )

                metricCard(
                    title: "Running agents",
                    value: "\(inventory.running)",
                    subtitle: inventory.running == 0 ? "No active runs" : "Using execution slots",
                    progress: progressFraction(active: inventory.running, total: max(inventory.active, 1)),
                    tint: .green
                )

                metricCard(
                    title: "Waiting to retry",
                    value: "\(inventory.queued)",
                    subtitle: waitingSubtitle(snapshot, inventory: inventory),
                    progress: progressFraction(active: inventory.queued, total: max(inventory.active, 1)),
                    tint: .orange
                )

                metricCard(
                    title: "Completed",
                    value: "\(inventory.completed)",
                    subtitle: "Finished this session",
                    progress: progressFraction(active: inventory.completed, total: max(inventory.active + inventory.completed, 1)),
                    tint: .blue
                )

                if snapshot.codexRateLimit.resumeAfterMs != nil {
                    rateLimitCard(snapshot: snapshot)
                }

                if let configError = snapshot.lastConfigError, !configError.isEmpty {
                    infoBanner(configError, color: .red)
                }

                if !snapshot.agentRows().isEmpty {
                    Text("Recent activity")
                        .font(.subheadline.weight(.semibold))
                    ForEach(snapshot.agentRows().prefix(4)) { row in
                        compactAgentRow(row)
                    }
                }
            } else if !service.isOnline {
                emptyState(
                    symbol: "waveform.slash",
                    title: "Symphony is offline",
                    detail: "Start the daemon to monitor agents."
                )
            }
        }
    }

    private var agentSectionContent: some View {
        Group {
            if let snapshot = service.snapshot, service.isOnline {
                let rows = rowsForCurrentSection(snapshot: snapshot)
                if rows.isEmpty {
                    emptyState(
                        symbol: section.symbol,
                        title: "No \(section.title.lowercased()) agents",
                        detail: "Nothing in this state right now."
                    )
                } else {
                    ForEach(rows) { row in
                        AgentRowView(
                            row: row,
                            canOpenLinear: linearIssueURL(
                                for: row.identifier,
                                orgSlug: service.settings.linearOrgSlug
                            ) != nil
                        ) {
                            service.openIssue(row.identifier)
                        } onOpenLogs: {
                            service.openLogs(for: row.identifier)
                        } onRetry: {
                            service.resumeIssue(row.identifier)
                        }
                    }
                }
            } else {
                emptyState(
                    symbol: "waveform.slash",
                    title: "Symphony is offline",
                    detail: "Start the daemon to see agents."
                )
            }
        }
    }

    private var settingsContent: some View {
        SettingsInlineView(settings: service.settings) { updated in
            service.settings = updated
            updated.save()
            if updated.notificationsEnabled {
                NotificationService.shared.requestAuthorizationIfNeeded()
            }
            service.start()
        }
    }

    private var panelFooter: some View {
        HStack {
            Text(appVersion)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Spacer()
            Text(pollFooterText)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        return "Symphony \(version)"
    }

    private var pollFooterText: String {
        let elapsed = Int(Date().timeIntervalSince(service.lastUpdated))
        let next = max(0, Int(service.settings.pollIntervalSeconds) - elapsed)
        if next > 0 {
            return "Next update in \(next)s"
        }
        return "Updated \(elapsed)s ago"
    }

    private func rowsForCurrentSection(snapshot: OrchestratorSnapshot) -> [AgentRow] {
        switch section {
        case .running:
            return snapshot.rows(for: .running)
        case .waiting:
            return snapshot.rows(for: .waiting)
        case .done:
            return snapshot.rows(for: .done)
        default:
            return []
        }
    }

    private func activeAgentsSubtitle(_ inventory: AgentInventory) -> String {
        if inventory.active == 0 {
            return "No in-flight work"
        }
        if inventory.queued == 0 {
            return "\(inventory.running) running"
        }
        return "\(inventory.running) running · \(inventory.queued) queued"
    }

    private func progressFraction(active: Int, total: Int) -> Double {
        Double(active) / Double(max(total, 1))
    }

    private func waitingSubtitle(_ snapshot: OrchestratorSnapshot, inventory: AgentInventory) -> String {
        if snapshot.codexRateLimit.resumeAfterMs != nil {
            return "Blocked by Codex rate limit"
        }
        if inventory.queued == 0 {
            return "Queue is clear"
        }
        if inventory.parked > 0, inventory.waiting > 0 {
            return "\(inventory.parked) rate limited · \(inventory.waiting) scheduled"
        }
        if inventory.parked > 0 {
            return "Rate limited"
        }
        return "Scheduled for retry"
    }

    private func rateLimitCard(snapshot: OrchestratorSnapshot) -> some View {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let resumeMs = snapshot.codexRateLimit.resumeAfterMs ?? nowMs
        let remainingMs = max(resumeMs - nowMs, 0)

        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("Codex rate limited", systemImage: "exclamationmark.triangle.fill")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.orange)
                Spacer()
                Button("Resume All") {
                    service.resumeRateLimited()
                }
                .controlSize(.small)
                .disabled(service.isBusy)
            }
            ProgressView(value: 1.0)
                .tint(.orange)
            Text("Resumes in \(formatDuration(remainingMs))")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.orange.opacity(0.08)))
    }

    private func metricCard(
        title: String,
        value: String,
        subtitle: String,
        progress: Double,
        tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Spacer()
                Text(value)
                    .font(.title3.weight(.bold))
                    .foregroundStyle(tint)
            }
            ProgressView(value: min(max(progress, 0.05), 1.0))
                .tint(tint)
            Text(subtitle)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
    }

    private func compactAgentRow(_ row: AgentRow) -> some View {
        Button {
            service.openIssue(row.identifier)
        } label: {
            HStack {
                Text(row.identifier)
                    .font(.body.weight(.medium))
                Spacer()
                Text(row.status)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(statusColor(for: row.kind))
            }
        }
        .buttonStyle(.plain)
    }

    private func infoBanner(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8).fill(color.opacity(0.1)))
    }

    private func emptyState(symbol: String, title: String, detail: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text(title)
                .font(.headline)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 32)
    }

    private func statusColor(for kind: AgentKind) -> Color {
        switch kind {
        case .running: return .green
        case .retry: return .orange
        case .parked: return .yellow
        case .completed: return .blue
        }
    }
}

struct SettingsInlineView: View {
    @State var settings: AppSettings
    let onSave: (AppSettings) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Stepper(value: $settings.statusPort, in: 1024 ... 65535) {
                Text("Status port: \(settings.statusPort)")
            }
            TextField("Linear org slug", text: $settings.linearOrgSlug)
            Stepper(value: $settings.pollIntervalSeconds, in: 2 ... 60) {
                Text("Poll every \(Int(settings.pollIntervalSeconds))s")
            }
            Toggle("Status change notifications", isOn: $settings.notificationsEnabled)
            Button("Save Settings") {
                onSave(settings)
            }
            .buttonStyle(.borderedProminent)
            Button("Open daemon log") {
                let path = FileManager.default.homeDirectoryForCurrentUser
                    .appendingPathComponent(".symphony/symphony-\(settings.statusPort).log")
                if FileManager.default.fileExists(atPath: path.path) {
                    NSWorkspace.shared.open(path)
                }
            }
            Button("Quit Symphony") {
                NSApplication.shared.terminate(nil)
            }
            .foregroundStyle(.red)
        }
    }
}
