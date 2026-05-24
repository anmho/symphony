import Foundation

public enum StatusControlError: LocalizedError {
    case offline(port: Int)
    case requestFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .offline(port):
            return "Symphony is not running on port \(port)."
        case let .requestFailed(message):
            return message
        }
    }
}

public enum StatusControl {
    public static func resumeIssue(_ issue: String, port: Int) async throws -> ResumeIssueResult {
        try await postControl(path: "resume-issue", body: ["issue": issue], port: port)
    }

    public static func resumeRateLimited(port: Int) async throws -> ResumeRateLimitedResult {
        try await postControl(path: "resume-rate-limited", body: [:], port: port)
    }

    public static func pauseDispatch(port: Int) async throws -> PauseDispatchResult {
        try await postControl(path: "pause", body: [:], port: port)
    }

    public static func resumeDispatch(port: Int) async throws -> ResumeDispatchResult {
        try await postControl(path: "resume", body: [:], port: port)
    }

    public static func queueSteer(_ issue: String, text: String, port: Int) async throws -> SteerResult {
        try await postControl(path: "steer", body: ["issue": issue, "text": text], port: port)
    }

    private static func postControl<T: Decodable>(
        path: String,
        body: [String: String],
        port: Int
    ) async throws -> T {
        guard let url = URL(string: "http://127.0.0.1:\(port)/control/\(path)") else {
            throw StatusControlError.requestFailed("Invalid control URL.")
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        request.timeoutInterval = 10

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw StatusControlError.offline(port: port)
        }

        guard let http = response as? HTTPURLResponse else {
            throw StatusControlError.requestFailed("Unexpected response from Symphony.")
        }

        guard (200 ..< 300).contains(http.statusCode) else {
            if http.statusCode == 404 {
                throw StatusControlError.offline(port: port)
            }
            let message = String(data: data, encoding: .utf8) ?? "HTTP \(http.statusCode)"
            throw StatusControlError.requestFailed(message)
        }

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw StatusControlError.requestFailed("Failed to decode Symphony response.")
        }
    }
}

public struct ResumeIssueResult: Codable {
    public let resumed: Bool
    public let issue: String
}

public struct ResumeRateLimitedResult: Codable {
    public let resumed: Int
}

public struct PauseDispatchResult: Codable {
    public let paused: Bool
}

public struct ResumeDispatchResult: Codable {
    public let paused: Bool
}

public struct SteerResult: Codable {
    public let queued: Bool
    public let issue: String
}
