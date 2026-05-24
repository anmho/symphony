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

    func start() {
        timer?.invalidate()
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
                    snapshot = nil
                    isOnline = false
                    lastError = "Symphony is not running on port \(statusPort)."
                    return
                }

                snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)
                isOnline = true
                lastError = nil
            } catch {
                lastUpdated = Date()
                snapshot = nil
                isOnline = false
                lastError = error.localizedDescription
            }
        }
    }

    func openIssue(_ identifier: String) {
        guard let url = linearIssueURL(for: identifier, orgSlug: settings.linearOrgSlug) else {
            actionError = "No Linear link for \(identifier). Check the org slug in Settings."
            return
        }
        NSWorkspace.shared.open(url)
    }

    func openWatch() {
        runDetached(["watch"])
    }

    func openLogs(for identifier: String) {
        runDetached(["logs", identifier, "-f"])
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
            self.snapshot = nil
            self.isOnline = false
        }
    }

    func resumeRateLimited() {
        performControl(success: "Resumed rate-limited runs.") {
            let result = try await StatusControl.resumeRateLimited(port: self.settings.statusPort)
            return "Resumed \(result.resumed) run\(result.resumed == 1 ? "" : "s")."
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

    private func runDetached(_ arguments: [String]) {
        actionError = nil
        do {
            _ = try SymphonyCLI.runDetached(arguments, statusPort: settings.statusPort)
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

    static let defaults = AppSettings(statusPort: 3979, linearOrgSlug: "anmho", pollIntervalSeconds: 5)

    static func load() -> AppSettings {
        let defaults = UserDefaults.standard
        return AppSettings(
            statusPort: defaults.object(forKey: "statusPort") as? Int ?? Self.defaults.statusPort,
            linearOrgSlug: defaults.string(forKey: "linearOrgSlug") ?? Self.defaults.linearOrgSlug,
            pollIntervalSeconds: defaults.object(forKey: "pollIntervalSeconds") as? TimeInterval ?? Self.defaults.pollIntervalSeconds
        )
    }

    func save() {
        let defaults = UserDefaults.standard
        defaults.set(statusPort, forKey: "statusPort")
        defaults.set(linearOrgSlug, forKey: "linearOrgSlug")
        defaults.set(pollIntervalSeconds, forKey: "pollIntervalSeconds")
    }
}
