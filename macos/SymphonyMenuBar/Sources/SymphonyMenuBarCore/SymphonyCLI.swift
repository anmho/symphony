import Foundation

public enum SymphonyCLIError: LocalizedError {
    case notOnPath
    case failed(exitCode: Int32, output: String)

    public var errorDescription: String? {
        switch self {
        case .notOnPath:
            return "symphony is not on PATH. Install the CLI with bun/npm and ensure it is linked."
        case let .failed(exitCode, output):
            if output.isEmpty {
                return "symphony exited with code \(exitCode)."
            }
            return output.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }
}

public struct SymphonyCLIResult {
    public let exitCode: Int32
    public let output: String
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
    public static func runDetached(_ arguments: [String], statusPort: Int) throws -> Int32 {
        try launch(arguments, statusPort: statusPort, wait: false).processIdentifier
    }

    public static func runSync(_ arguments: [String], statusPort: Int) throws -> SymphonyCLIResult {
        let task = try launch(arguments, statusPort: statusPort, wait: true)
        let output = readPipe(task.standardOutput as? Pipe)
        if task.terminationStatus != 0 {
            throw SymphonyCLIError.failed(exitCode: task.terminationStatus, output: output)
        }
        return SymphonyCLIResult(exitCode: task.terminationStatus, output: output)
    }

    private static func launch(_ arguments: [String], statusPort: Int, wait: Bool) throws -> Process {
        guard isAvailable() else {
            throw SymphonyCLIError.notOnPath
        }

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["symphony"] + arguments + ["--status-port", String(statusPort)]
        if wait {
            let pipe = Pipe()
            task.standardOutput = pipe
            task.standardError = pipe
        } else {
            task.standardOutput = FileHandle.nullDevice
            task.standardError = FileHandle.nullDevice
        }
        try task.run()
        if wait {
            task.waitUntilExit()
        }
        return task
    }

    private static func readPipe(_ pipe: Pipe?) -> String {
        guard let pipe else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
