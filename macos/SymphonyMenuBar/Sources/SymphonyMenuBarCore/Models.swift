import Foundation

public struct OrchestratorSnapshot: Codable {
    public let startedAtMs: Int
    public let running: [LiveSession]
    public let retryAttempts: [RunAttempt]
    public let completed: [String]
    public let codexRateLimit: CodexRateLimitSnapshot
    public let lastConfigError: String?
    public let paused: Bool
    public let pausedAtMs: Int?

    enum CodingKeys: String, CodingKey {
        case startedAtMs
        case running
        case retryAttempts
        case completed
        case codexRateLimit
        case lastConfigError
        case paused
        case pausedAtMs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        startedAtMs = try container.decode(Int.self, forKey: .startedAtMs)
        running = try container.decode([LiveSession].self, forKey: .running)
        retryAttempts = try container.decode([RunAttempt].self, forKey: .retryAttempts)
        completed = try container.decode([String].self, forKey: .completed)
        codexRateLimit = try container.decode(CodexRateLimitSnapshot.self, forKey: .codexRateLimit)
        lastConfigError = try container.decodeIfPresent(String.self, forKey: .lastConfigError)
        paused = try container.decodeIfPresent(Bool.self, forKey: .paused) ?? false
        pausedAtMs = try container.decodeIfPresent(Int.self, forKey: .pausedAtMs)
    }
}

public struct LiveSession: Codable, Identifiable {
    public var id: String { identifier }
    public let identifier: String
    public let title: String?
    public let turnCount: Int
    public let lastCodexEvent: String?
    public let lastCodexTimestamp: Int?
    public let lastCodexMessage: String?
    public let startedAtMs: Int
    public let workspacePath: String?
}

public struct RunAttempt: Codable, Identifiable {
    public var id: String { "\(identifier)-\(attempt)" }
    public let identifier: String
    public let title: String?
    public let attempt: Int
    public let dueAtMs: Int
    public let error: String?
}

public struct CodexRateLimitSnapshot: Codable {
    public let resumeAfterMs: Int?
    public let reason: String?
}

public struct AgentRow: Identifiable {
    public let id: String
    public let identifier: String
    public let title: String?
    public let status: String
    public let detail: String
    public let kind: AgentKind

    public var headline: String {
        issueHeadline(identifier: identifier, title: title)
    }
}

public enum AgentKind {
    case running
    case retry
    case parked
    case completed
}

public struct AgentInventory: Equatable {
    public let running: Int
    public let waiting: Int
    public let parked: Int
    public let completed: Int
    public let active: Int

    public var queued: Int { waiting + parked }
}

public enum AgentSection {
    case running
    case waiting
    case done
}

public func isRateLimitedError(_ value: String?) -> Bool {
    guard let value, !value.isEmpty else { return false }
    if value == "codex_rate_limited" {
        return true
    }
    if value.localizedCaseInsensitiveContains("usage limit") {
        return true
    }
    if value.contains("usageLimitExceeded") {
        return true
    }
    if let summary = summarizeRetryError(value),
       summary.localizedCaseInsensitiveContains("usage limit") {
        return true
    }
    return false
}

public extension OrchestratorSnapshot {
    func agentRows(nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> [AgentRow] {
        var rows: [AgentRow] = running.map { session in
            AgentRow(
                id: "running-\(session.identifier)",
                identifier: session.identifier,
                title: session.title,
                status: "running",
                detail: sessionDetail(session, nowMs: nowMs),
                kind: .running
            )
        }

        rows += retryAttempts.map { attempt in
            let parked = isParkedAttempt(attempt)
            return AgentRow(
                id: attempt.id,
                identifier: attempt.identifier,
                title: attempt.title,
                status: parked ? "parked" : "retry",
                detail: retryDetail(attempt, parked: parked, nowMs: nowMs),
                kind: parked ? .parked : .retry
            )
        }

        rows += completed.map { issueId in
            AgentRow(
                id: "completed-\(issueId)",
                identifier: issueId,
                title: nil,
                status: "completed",
                detail: "Finished",
                kind: .completed
            )
        }

        return rows
    }

    func agentInventory(nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> AgentInventory {
        let rows = agentRows(nowMs: nowMs)
        let runningCount = rows.filter { $0.kind == .running }.count
        let parkedCount = rows.filter { $0.kind == .parked }.count
        let waitingCount = rows.filter { $0.kind == .retry }.count
        let completedCount = rows.filter { $0.kind == .completed }.count
        let activeIdentifiers = Set(
            rows.filter { $0.kind != .completed }.map(\.identifier)
        )
        return AgentInventory(
            running: runningCount,
            waiting: waitingCount,
            parked: parkedCount,
            completed: completedCount,
            active: activeIdentifiers.count
        )
    }

    func rows(for section: AgentSection, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> [AgentRow] {
        agentRows(nowMs: nowMs).filter { row in
            switch section {
            case .running:
                return row.kind == .running
            case .waiting:
                return row.kind == .retry || row.kind == .parked
            case .done:
                return row.kind == .completed
            }
        }
    }

    private func isParkedAttempt(_ attempt: RunAttempt) -> Bool {
        isRateLimitedError(attempt.error)
    }

    private func retryDetail(_ attempt: RunAttempt, parked: Bool, nowMs: Int) -> String {
        if parked {
            if let resumeAfterMs = codexRateLimit.resumeAfterMs {
                let wait = formatDuration(max(resumeAfterMs - nowMs, 0))
                return "Rate limited · resumes in \(wait)"
            }
            return summarizeRetryError(attempt.error) ?? "Rate limited"
        }
        let wait = formatDuration(max(attempt.dueAtMs - nowMs, 0))
        let error = summarizeRetryError(attempt.error)
        if let error {
            return "Retry #\(attempt.attempt) in \(wait) · \(error)"
        }
        return "Retry #\(attempt.attempt) in \(wait)"
    }

    private func sessionDetail(_ session: LiveSession, nowMs: Int) -> String {
        let age = formatDuration(max(nowMs - session.startedAtMs, 0))
        let event = session.lastCodexEvent ?? "-"
        let message = summarizeCodexMessage(session.lastCodexMessage)
        return "Turn \(session.turnCount) · \(event) · \(message) · \(age)"
    }
}

public func summarizeRetryError(_ value: String?) -> String? {
    guard let value, !value.isEmpty else { return nil }
    if value == "codex_rate_limited" {
        return "Codex rate limited"
    }

    guard
        let data = value.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return truncate(value, 120)
    }

    if let message = parsed["message"] as? String {
        return truncate(message, 120)
    }
    if let info = parsed["codexErrorInfo"] as? String {
        return truncate(info, 120)
    }
    return truncate(value, 120)
}

public func summarizeCodexMessage(_ value: String?) -> String {
    guard let value, !value.isEmpty else {
        return "-"
    }

    guard
        let data = value.data(using: .utf8),
        let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        return truncate(value, 180)
    }

    let params = parsed["params"] as? [String: Any]
    let item = params?["item"] as? [String: Any]
    if let command = item?["command"] as? String {
        let type = item?["type"] as? String ?? "command"
        let status = item?["status"] as? String ?? ""
        return truncate("\(type) \(status): \(command)".trimmingCharacters(in: .whitespaces), 180)
    }
    if let text = item?["text"] as? String {
        return truncate(text, 180)
    }
    if let delta = params?["delta"] as? String {
        return truncate("delta: \(delta)", 180)
    }
    if let method = parsed["method"] as? String {
        return truncate(method, 180)
    }
    return truncate(value, 180)
}

public func truncate(_ value: String, _ maxLength: Int) -> String {
    guard value.count > maxLength else { return value }
    return String(value.prefix(maxLength - 1)) + "…"
}

public func formatDuration(_ ms: Int) -> String {
    let totalSeconds = max(ms / 1000, 0)
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    if hours > 0 { return "\(hours)h\(minutes)m" }
    if minutes > 0 { return "\(minutes)m\(seconds)s" }
    return "\(seconds)s"
}

public func issueHeadline(identifier: String, title: String?) -> String {
    guard let title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return identifier
    }
    return "\(identifier) · \(title)"
}

public func linearIssueURL(for identifier: String, orgSlug: String) -> URL? {
    guard identifier.range(of: #"^[A-Z]+-\d+$"#, options: .regularExpression) != nil else {
        return nil
    }
    let slug = orgSlug.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !slug.isEmpty else { return nil }
    return URL(string: "https://linear.app/\(slug)/issue/\(identifier)")
}
