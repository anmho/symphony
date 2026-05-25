import AppKit
import Foundation
import SymphonyMenuBarCore

@MainActor
final class StatusService: ObservableObject {
    @Published private(set) var snapshot: OrchestratorSnapshot?
    @Published private(set) var isOnline = false
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdated = Date()
    @Published var actionError: String?
    @Published var actionMessage: String?
    @Published private(set) var isBusy = false

    var settings = AppSettings.load()

    private var timer: Timer?
    private var lastMonitorState: MonitorState?

    func start() {
        timer?.invalidate()
        NotificationService.shared.requestAuthorizationIfNeeded()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: settings.pollIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.refresh()
            }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    func refresh() {
        settings = AppSettings.load()
        let url = URL(string: "http://127.0.0.1:\(settings.statusPort)/status")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 3
        let statusPort = settings.statusPort

        Task {
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                lastUpdated = Date()

                guard
                    let http = response as? HTTPURLResponse,
                    (200 ..< 300).contains(http.statusCode)
                else {
                    applyMonitorState(.offline(), lastError: "Symphony is not running on port \(statusPort).")
                    return
                }

                let decoded = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)
                applyMonitorState(MonitorState(snapshot: decoded, isOnline: true), snapshot: decoded)
            } catch {
                lastUpdated = Date()
                applyMonitorState(.offline(), lastError: error.localizedDescription)
            }
        }
    }

    private func applyMonitorState(
        _ state: MonitorState,
        snapshot newSnapshot: OrchestratorSnapshot? = nil,
        lastError newLastError: String? = nil
    ) {
        let changes = StatusChangeDetector.changes(from: lastMonitorState, to: state)
        lastMonitorState = state
        snapshot = newSnapshot
        isOnline = state.isOnline
        lastError = newLastError

        for change in changes {
            NotificationService.shared.post(change)
        }
    }

    private func resetMonitorState() {
        lastMonitorState = nil
    }

    func openIssue(_ identifier: String) {
        guard let url = linearIssueURL(for: identifier, orgSlug: settings.linearOrgSlug) else {
            actionError = "No Linear link for \(identifier). Check the org slug in Settings."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func openGitHubRepo(_ repoKey: String?) {
        guard let url = githubRepositoryURL(for: repoKey, ownerSlug: settings.linearOrgSlug) else {
            actionError = "No GitHub repo link for this row."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func openPullRequest(_ prUrl: String?) {
        guard let prUrl, let url = URL(string: prUrl) else {
            actionError = "No GitHub PR link for this row."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func openWatch() {
        openInTerminal(["watch"])
    }

    func openLogs(for identifier: String) {
        openInTerminal(["logs", identifier, "-f"])
    }

    func openDaemonLog() {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".symphony/symphony-\(settings.statusPort).log")
        guard FileManager.default.fileExists(atPath: path.path) else {
            actionError = "No log file at \(path.path)."
            return
        }
        NSWorkspace.shared.open(path)
    }

    func startSymphony() {
        performCLI(["start"], success: "Symphony started.") {
            try await self.waitForOnline()
        }
    }

    func stopSymphony() {
        performCLI(["stop"], success: "Symphony stopped.") {
            self.applyMonitorState(.offline())
            self.resetMonitorState()
        }
    }

    func resumeRateLimited() {
        performControl(success: "Resumed rate-limited runs.") {
            let result = try await StatusControl.resumeRateLimited(port: self.settings.statusPort)
            return "Resumed \(result.resumed) run\(result.resumed == 1 ? "" : "s")."
        }
    }

    func pauseDispatch() {
        performControlWithCLIFallback(
            cliArguments: ["pause"],
            success: "Symphony dispatch paused."
        ) {
            _ = try await StatusControl.pauseDispatch(port: self.settings.statusPort)
            return "Symphony dispatch paused."
        }
    }

    func resumeDispatch() {
        performControlWithCLIFallback(
            cliArguments: ["unpause"],
            success: "Symphony dispatch resumed."
        ) {
            _ = try await StatusControl.resumeDispatch(port: self.settings.statusPort)
            return "Symphony dispatch resumed."
        }
    }

    func resumeIssue(_ identifier: String) {
        performControl(success: "Queued \(identifier) for retry.") {
            let result = try await StatusControl.resumeIssue(identifier, port: self.settings.statusPort)
            if result.resumed {
                return "Resumed \(result.issue)."
            }
            return "\(result.issue) was not queued for retry."
        }
    }

    func requestCodexReview(_ identifier: String, prUrl: String?) {
        var arguments = ["review", "request", identifier]
        if let prUrl {
            arguments.append(contentsOf: ["--pr", prUrl])
        }
        performCLI(
            arguments,
            success: "Requested Codex review for \(identifier)."
        )
    }

    func requestChanges(_ identifier: String) {
        guard let feedback = promptForReviewFeedback(identifier: identifier) else {
            return
        }
        performControl(success: "Sent \(identifier) back for rework.") {
            let result = try await StatusControl.requestChanges(
                identifier,
                feedback: feedback,
                port: self.settings.statusPort
            )
            return "Moved \(result.issue) to \(result.state) for rework."
        }
    }

    private func promptForReviewFeedback(identifier: String) -> String? {
        let alert = NSAlert()
        alert.messageText = "Request changes for \(identifier)"
        alert.informativeText = "This writes the feedback to Linear and moves the issue back to active Symphony work."
        alert.addButton(withTitle: "Send Back")
        alert.addButton(withTitle: "Cancel")

        let scrollView = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 140))
        scrollView.hasVerticalScroller = true
        let textView = NSTextView(frame: scrollView.bounds)
        textView.string = ""
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.isRichText = false
        textView.autoresizingMask = [.width, .height]
        scrollView.documentView = textView
        alert.accessoryView = scrollView

        let response = alert.runModal()
        guard response == .alertFirstButtonReturn else {
            return nil
        }
        let feedback = textView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        if feedback.isEmpty {
            actionError = "Feedback is required to request changes."
            return nil
        }
        return feedback
    }

    private func performCLI(
        _ arguments: [String],
        success: String,
        afterSuccess: (() async throws -> Void)? = nil
    ) {
        guard !isBusy else { return }
        actionError = nil
        actionMessage = nil
        isBusy = true

        Task {
            defer { isBusy = false }
            do {
                _ = try SymphonyCLI.runSync(arguments, statusPort: settings.statusPort)
                if let afterSuccess {
                    try await afterSuccess()
                }
                actionMessage = success
                refresh()
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func performControl(
        success: String,
        operation: @escaping () async throws -> String
    ) {
        guard !isBusy else { return }
        actionError = nil
        actionMessage = nil
        isBusy = true

        Task {
            defer { isBusy = false }
            do {
                let message = try await operation()
                actionMessage = message.isEmpty ? success : message
                refresh()
            } catch {
                actionError = error.localizedDescription
            }
        }
    }

    private func performControlWithCLIFallback(
        cliArguments: [String],
        success: String,
        operation: @escaping () async throws -> String
    ) {
        guard !isBusy else { return }
        actionError = nil
        actionMessage = nil
        isBusy = true

        Task {
            defer { isBusy = false }
            do {
                let message = try await operation()
                actionMessage = message.isEmpty ? success : message
                refresh()
            } catch {
                do {
                    _ = try SymphonyCLI.runSync(cliArguments, statusPort: settings.statusPort)
                    actionMessage = success
                    refresh()
                } catch {
                    actionError = error.localizedDescription
                }
            }
        }
    }

    private func openInTerminal(_ arguments: [String]) {
        actionError = nil
        do {
            try TerminalLauncher.openSymphonyCommand(arguments, statusPort: settings.statusPort)
        } catch {
            actionError = error.localizedDescription
        }
    }

    private func waitForOnline() async throws {
        for _ in 0 ..< 50 {
            refresh()
            try await Task.sleep(nanoseconds: 200_000_000)
            if isOnline {
                return
            }
        }
        throw SymphonyCLIError.failed(exitCode: 1, output: "Symphony did not become reachable on port \(settings.statusPort).")
    }
}

struct AppSettings: Equatable {
    var statusPort: Int
    var linearOrgSlug: String
    var pollIntervalSeconds: TimeInterval
    var notificationsEnabled: Bool

    static let defaults = AppSettings(
        statusPort: 3979,
        linearOrgSlug: "anmho",
        pollIntervalSeconds: 5,
        notificationsEnabled: true
    )

    static func load() -> AppSettings {
        let defaults = UserDefaults.standard
        return AppSettings(
            statusPort: defaults.object(forKey: "statusPort") as? Int ?? Self.defaults.statusPort,
            linearOrgSlug: defaults.string(forKey: "linearOrgSlug") ?? Self.defaults.linearOrgSlug,
            pollIntervalSeconds: defaults.object(forKey: "pollIntervalSeconds") as? TimeInterval ?? Self.defaults.pollIntervalSeconds,
            notificationsEnabled: defaults.object(forKey: "notificationsEnabled") as? Bool ?? Self.defaults.notificationsEnabled
        )
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(statusPort, forKey: "statusPort")
        defaults.set(linearOrgSlug, forKey: "linearOrgSlug")
        defaults.set(pollIntervalSeconds, forKey: "pollIntervalSeconds")
        defaults.set(notificationsEnabled, forKey: "notificationsEnabled")
    }
}
