import XCTest
@testable import SymphonyMenuBarCore

final class SymphonyCLITests: XCTestCase {
    func testEnvironmentPrependsLocalBinPaths() {
        let environment = SymphonyCLI.environmentWithLocalBinPaths(
            base: [
                "HOME": "/Users/example",
                "PATH": "/usr/bin:/bin"
            ]
        )

        XCTAssertEqual(
            environment["PATH"],
            "/Users/example/.bun/bin:/Users/example/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        )
    }
}
