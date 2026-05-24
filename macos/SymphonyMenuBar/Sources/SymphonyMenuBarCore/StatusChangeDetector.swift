import Foundation

public struct MonitorState: Equatable {
    public var isOnline: Bool
    public var running: Set<String>
    public var retrying: Set<String>
    public var parked: Set<String>
    public var completed: Set<String>
    public var rateLimited: Bool
    public var configError: String?

    public static func offline() -> MonitorState {
        MonitorState(
            isOnline: false,
            running: [],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )
    }

    public init(
        isOnline: Bool,
        running: Set<String>,
        retrying: Set<String>,
        parked: Set<String>,
        completed: Set<String>,
        rateLimited: Bool,
        configError: String?
    ) {
        self.isOnline = isOnline
        self.running = running
        self.retrying = retrying
        self.parked = parked
        self.completed = completed
        self.rateLimited = rateLimited
        self.configError = configError
    }

    public init(snapshot: OrchestratorSnapshot, isOnline: Bool) {
        var retrying = Set<String>()
        var parked = Set<String>()
        for attempt in snapshot.retryAttempts {
            if isRateLimitedError(attempt.error) {
                parked.insert(attempt.identifier)
            } else {
                retrying.insert(attempt.identifier)
            }
        }

        self.init(
            isOnline: isOnline,
            running: Set(snapshot.running.map(\.identifier)),
            retrying: retrying,
            parked: parked,
            completed: Set(snapshot.completed),
            rateLimited: snapshot.codexRateLimit.resumeAfterMs != nil,
            configError: snapshot.lastConfigError.flatMap { $0.isEmpty ? nil : $0 }
        )
    }
}

public struct StatusNotification: Equatable {
    public let title: String
    public let body: String
    public let identifier: String

    public init(title: String, body: String, identifier: String) {
        self.title = title
        self.body = body
        self.identifier = identifier
    }
}

public enum StatusChangeDetector {
    public static func changes(from previous: MonitorState?, to current: MonitorState) -> [StatusNotification] {
        guard let previous else {
            return []
        }

        var notifications: [StatusNotification] = []

        if previous.isOnline != current.isOnline {
            if current.isOnline {
                notifications.append(
                    StatusNotification(
                        title: "Symphony connected",
                        body: "Status polling is live.",
                        identifier: "symphony.online"
                    )
                )
            } else {
                notifications.append(
                    StatusNotification(
                        title: "Symphony offline",
                        body: "The daemon is no longer reachable.",
                        identifier: "symphony.offline"
                    )
                )
            }
        }

        if !previous.rateLimited, current.rateLimited {
            let waiting = current.retrying.count + current.parked.count
            let detail = waiting > 0 ? "\(waiting) run\(waiting == 1 ? "" : "s") waiting." : "New runs are blocked."
            notifications.append(
                StatusNotification(
                    title: "Codex rate limited",
                    body: detail,
                    identifier: "symphony.rate_limit.on"
                )
            )
        } else if previous.rateLimited, !current.rateLimited {
            notifications.append(
                StatusNotification(
                    title: "Codex rate limit cleared",
                    body: "Symphony can dispatch runs again.",
                    identifier: "symphony.rate_limit.off"
                )
            )
        }

        for identifier in current.running.subtracting(previous.running) {
            notifications.append(
                StatusNotification(
                    title: "\(identifier) started",
                    body: "Agent is now running.",
                    identifier: "agent.started.\(identifier)"
                )
            )
        }

        for identifier in current.completed.subtracting(previous.completed) {
            notifications.append(
                StatusNotification(
                    title: "\(identifier) finished",
                    body: "Agent completed successfully.",
                    identifier: "agent.completed.\(identifier)"
                )
            )
        }

        for identifier in current.parked.subtracting(previous.parked) {
            notifications.append(
                StatusNotification(
                    title: "\(identifier) parked",
                    body: "Waiting on Codex rate limit.",
                    identifier: "agent.parked.\(identifier)"
                )
            )
        }

        for identifier in current.retrying.subtracting(previous.retrying) {
            notifications.append(
                StatusNotification(
                    title: "\(identifier) retrying",
                    body: "Agent is queued for another attempt.",
                    identifier: "agent.retry.\(identifier)"
                )
            )
        }

        for identifier in previous.running.intersection(current.parked.union(current.retrying)) {
            let kind = current.parked.contains(identifier) ? "parked" : "retrying"
            notifications.append(
                StatusNotification(
                    title: "\(identifier) stopped",
                    body: "Run is now \(kind).",
                    identifier: "agent.stopped.\(identifier).\(kind)"
                )
            )
        }

        if previous.configError != current.configError, let configError = current.configError {
            notifications.append(
                StatusNotification(
                    title: "Symphony config error",
                    body: truncate(configError, 180),
                    identifier: "symphony.config_error"
                )
            )
        }

        return notifications
    }
}
