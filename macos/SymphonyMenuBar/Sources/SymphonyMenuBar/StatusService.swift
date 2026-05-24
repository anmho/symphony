import AppKit
import Foundation

@MainActor
final class StatusService: ObservableObject {
    @Published private(set) var snapshot: OrchestratorSnapshot?
    @Published private(set) var isOnline = false
    @Published private(set) var lastError: String?
    @Published private(set) var lastUpdated = Date()

    var settings = AppSettings.load()

    private var timer: Timer?

    func start() {
        timer?.invalidate()
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: settings.pollIntervalSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in
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

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            Task { @MainActor in
                guard let self else { return }
                self.lastUpdated = Date()

                if let error {
                    self.snapshot = nil
                    self.isOnline = false
                    self.lastError = error.localizedDescription
                    return
                }

                guard
                    let http = response as? HTTPURLResponse,
                    (200 ..< 300).contains(http.statusCode),
                    let data
                else {
                    self.snapshot = nil
                    self.isOnline = false
                    self.lastError = "Symphony is not running on port \(self.settings.statusPort)."
                    return
                }

                do {
                    self.snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)
                    self.isOnline = true
                    self.lastError = nil
                } catch {
                    self.snapshot = nil
                    self.isOnline = false
                    self.lastError = "Invalid status payload."
                }
            }
        }.resume()
    }

    func openIssue(_ identifier: String) {
        guard let url = linearIssueURL(for: identifier, orgSlug: settings.linearOrgSlug) else { return }
        NSWorkspace.shared.open(url)
    }

    func openWatch() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["symphony", "watch", "--status-port", String(settings.statusPort)]
        try? task.run()
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
