import XCTest
@testable import SymphonyMenuBarCore

final class TerminalLauncherTests: XCTestCase {
    func testShellCommandIncludesLoginShellAndStatusPort() {
        let command = TerminalLauncher.shellCommand(arguments: ["watch"], statusPort: 3979)
        XCTAssertTrue(command.hasPrefix("zsh -lc "))
        XCTAssertTrue(command.contains("symphony watch"))
        XCTAssertTrue(command.contains("--status-port 3979"))
        XCTAssertTrue(command.contains("$HOME/.bun/bin"))
    }

    func testShellCommandQuotesIssueIdentifier() {
        let command = TerminalLauncher.shellCommand(arguments: ["logs", "ANM-277", "-f"], statusPort: 3979)
        XCTAssertTrue(command.contains("symphony logs ANM-277 -f"))
    }

    func testAppleScriptTargetsITerm() {
        let script = TerminalLauncher.appleScript(for: .iTerm2, command: "zsh -lc 'symphony watch'")
        XCTAssertTrue(script.contains("tell application \"iTerm\""))
        XCTAssertTrue(script.contains("write text \"zsh -lc 'symphony watch'\""))
    }

    func testAppleScriptTargetsTerminal() {
        let script = TerminalLauncher.appleScript(for: .terminal, command: "zsh -lc 'symphony watch'")
        XCTAssertTrue(script.contains("tell application \"Terminal\""))
        XCTAssertTrue(script.contains("do script \"zsh -lc 'symphony watch'\""))
    }

    func testAppleScriptEscapesEmbeddedQuotes() {
        let script = TerminalLauncher.appleScript(for: .terminal, command: "echo \"hi\"")
        XCTAssertTrue(script.contains("echo \\\"hi\\\""))
    }
}
