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
        executableURL() != nil
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
        guard let executable = executableURL() else {
            throw SymphonyCLIError.notOnPath
        }

        let task = Process()
        task.executableURL = executable
        task.arguments = arguments + ["--status-port", String(statusPort)]
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

    static func executableURL(fileManager: FileManager = .default) -> URL? {
        let home = fileManager.homeDirectoryForCurrentUser.path
        let candidates = [
            "\(home)/.bun/bin/symphony",
            "\(home)/.local/bin/symphony",
            "/opt/homebrew/bin/symphony",
            "/usr/local/bin/symphony"
        ] + nvmCandidates(home: home, fileManager: fileManager)

        return candidates
            .map(URL.init(fileURLWithPath:))
            .first { fileManager.isExecutableFile(atPath: $0.path) }
    }

    private static func nvmCandidates(home: String, fileManager: FileManager) -> [String] {
        let versionsURL = URL(fileURLWithPath: "\(home)/.nvm/versions/node")
        let versions = (try? fileManager.contentsOfDirectory(
            at: versionsURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        return versions
            .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending }
            .map { $0.appendingPathComponent("bin/symphony").path }
    }

    private static func readPipe(_ pipe: Pipe?) -> String {
        guard let pipe else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
