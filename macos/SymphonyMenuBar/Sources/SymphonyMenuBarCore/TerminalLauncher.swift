import Foundation

public enum TerminalLauncherError: LocalizedError {
    case noTerminalFound
    case launchFailed(String)

    public var errorDescription: String? {
        switch self {
        case .noTerminalFound:
            return "No supported terminal found. Install iTerm2 or use Terminal.app."
        case let .launchFailed(message):
            return message
        }
    }
}

public enum TerminalLauncher {
    public enum TerminalApp: String, CaseIterable {
        case iTerm2
        case terminal
    }

    public static func preferredTerminal() -> TerminalApp? {
        if FileManager.default.fileExists(atPath: "/Applications/iTerm.app") {
            return .iTerm2
        }
        if FileManager.default.fileExists(atPath: "/System/Applications/Utilities/Terminal.app") {
            return .terminal
        }
        return nil
    }

    public static func shellCommand(arguments: [String], statusPort: Int) -> String {
        let symphonyArgs = (arguments + ["--status-port", String(statusPort)])
            .map(shellQuote)
            .joined(separator: " ")
        let inner = "export PATH=\"$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH\"; symphony \(symphonyArgs)"
        return "zsh -lc \(shellQuote(inner))"
    }

    public static func openSymphonyCommand(
        _ arguments: [String],
        statusPort: Int,
        terminal: TerminalApp? = nil
    ) throws {
        guard SymphonyCLI.isAvailable() else {
            throw SymphonyCLIError.notOnPath
        }
        guard let terminal = terminal ?? preferredTerminal() else {
            throw TerminalLauncherError.noTerminalFound
        }

        let command = shellCommand(arguments: arguments, statusPort: statusPort)
        let script = appleScript(for: terminal, command: command)
        try runAppleScript(script)
    }

    static func appleScript(for terminal: TerminalApp, command: String) -> String {
        let escaped = escapeForAppleScript(command)
        switch terminal {
        case .iTerm2:
            return """
            tell application "iTerm"
                activate
                create window with default profile
                tell current session of current window
                    write text "\(escaped)"
                end tell
            end tell
            """
        case .terminal:
            return """
            tell application "Terminal"
                activate
                do script "\(escaped)"
            end tell
            """
        }
    }

    static func shellQuote(_ value: String) -> String {
        if value.isEmpty {
            return "''"
        }
        if value.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." || $0 == "/" || $0 == ":" }) {
            return value
        }
        return "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
    }

    static func escapeForAppleScript(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private static func runAppleScript(_ source: String) throws {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        process.arguments = ["-e", source]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = pipe
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0 else {
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let message = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw TerminalLauncherError.launchFailed(message?.isEmpty == false ? message! : "Failed to open terminal.")
        }
    }
}
