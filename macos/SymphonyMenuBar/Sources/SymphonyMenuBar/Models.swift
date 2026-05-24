import Foundation

struct OrchestratorSnapshot: Codable {
    let startedAtMs: Int
    let running: [LiveSession]
    let retryAttempts: [RunAttempt]
    let completed: [String]
    let codexRateLimit: CodexRateLimitSnapshot
    let lastConfigError: String?
}

struct LiveSession: Codable, Identifiable {
    var id: String { identifier }
    let identifier: String
    let turnCount: Int
    let lastCodexEvent: String?
    let lastCodexTimestamp: Int?
    let startedAtMs: Int
    let workspacePath: String?
}

struct RunAttempt: Codable, Identifiable {
    var id: String { "\(identifier)-\(attempt)" }
    let identifier: String
    let attempt: Int
    let dueAtMs: Int
    let error: String?
}

struct CodexRateLimitSnapshot: Codable {
    let resumeAfterMs: Int?
    let reason: String?
}

struct AgentRow: Identifiable {
    let id: String
    let identifier: String
    let status: String
    let detail: String
    let kind: AgentKind
}

enum AgentKind {
    case running
    case retry
    case parked
    case completed
}

extension OrchestratorSnapshot {
    func agentRows(nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> [AgentRow] {
        var rows: [AgentRow] = running.map { session in
            AgentRow(
                id: session.identifier,
                identifier: session.identifier,
                status: "running",
                detail: sessionDetail(session, nowMs: nowMs),
                kind: .running
            )
        }

        rows += retryAttempts.map { attempt in
            let parked = attempt.error == "codex_rate_limited"
            return AgentRow(
                id: attempt.identifier,
                identifier: attempt.identifier,
                status: parked ? "parked" : "retry",
                detail: parked
                    ? "Rate limited"
                    : "Retry #\(attempt.attempt) in \(formatDuration(max(attempt.dueAtMs - nowMs, 0)))",
                kind: parked ? .parked : .retry
            )
        }

        rows += completed.map { issueId in
            AgentRow(
                id: issueId,
                identifier: issueId,
                status: "completed",
                detail: "Finished",
                kind: .completed
            )
        }

        return rows
    }

    private func sessionDetail(_ session: LiveSession, nowMs: Int) -> String {
        let age = formatDuration(max(nowMs - session.startedAtMs, 0))
        let event = session.lastCodexEvent ?? "-"
        return "Turn \(session.turnCount) · \(event) · \(age)"
    }
}

func formatDuration(_ ms: Int) -> String {
    let totalSeconds = max(ms / 1000, 0)
    let hours = totalSeconds / 3600
    let minutes = (totalSeconds % 3600) / 60
    let seconds = totalSeconds % 60
    if hours > 0 { return "\(hours)h\(minutes)m" }
    if minutes > 0 { return "\(minutes)m\(seconds)s" }
    return "\(seconds)s"
}

func linearIssueURL(for identifier: String, orgSlug: String) -> URL? {
    guard identifier.range(of: #"^[A-Z]+-\d+$"#, options: .regularExpression) != nil else {
        return nil
    }
    let slug = orgSlug.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    guard !slug.isEmpty else { return nil }
    return URL(string: "https://linear.app/\(slug)/issue/\(identifier)")
}
