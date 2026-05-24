import Foundation

public enum SymphonyCLIError: LocalizedError {
    case notOnPath

    public var errorDescription: String? {
        switch self {
        case .notOnPath:
            return "symphony is not on PATH. Install the CLI with bun/npm and ensure it is linked."
        }
    }
}

public enum SymphonyCLI {
    public static func isAvailable() -> Bool {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["sh", "-lc", "command -v symphony"]
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            return task.terminationStatus == 0
        } catch {
            return false
        }
    }

    @discardableResult
    public static func run(_ arguments: [String], statusPort: Int) throws -> Int32 {
        guard isAvailable() else {
            throw SymphonyCLIError.notOnPath
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["symphony"] + arguments + ["--status-port", String(statusPort)]
        try task.run()
        return task.processIdentifier
    }
}
