import Foundation
import SymphonyMenuBarCore
import XCTest

final class ModelsTests: XCTestCase {
    func testDecodesStatusFixture() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "status", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)

        XCTAssertEqual(snapshot.running.count, 1)
        XCTAssertEqual(snapshot.running[0].identifier, "ANM-1")
        XCTAssertEqual(snapshot.completed, ["ANM-99"])
    }

    func testIssueHeadlineIncludesTitleWhenAvailable() {
        XCTAssertEqual(
            issueHeadline(identifier: "ANM-279", title: "Implement observability slice"),
            "ANM-279 · Implement observability slice"
        )
        XCTAssertEqual(issueHeadline(identifier: "ANM-279", title: nil), "ANM-279")
    }

    func testAgentRowsIncludeIssueTitle() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "status", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)

        let rows = snapshot.agentRows(nowMs: 20_000)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].headline, "ANM-1 · Example Symphony issue")
        XCTAssertTrue(rows[0].detail.contains("Working on the ticket"))
        XCTAssertEqual(rows[1].status, "completed")
    }

    func testAgentRowsIncludeRetryAttemptsWhenNothingRunning() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "status-retries", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)

        let rows = snapshot.agentRows(nowMs: 1_000_000_000)
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0].identifier, "ANM-279")
        XCTAssertEqual(rows[0].status, "parked")
        XCTAssertTrue(rows[0].detail.localizedCaseInsensitiveContains("rate limit"))
        XCTAssertEqual(rows[1].identifier, "ANM-276")
        XCTAssertEqual(rows[1].status, "parked")
        XCTAssertEqual(Set(rows.map(\.id)).count, 2)
    }

    func testAgentInventoryMatchesRowFilters() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "status-retries", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)
        let inventory = snapshot.agentInventory(nowMs: 1_000_000_000)

        XCTAssertEqual(inventory.running, 0)
        XCTAssertEqual(inventory.waiting, 0)
        XCTAssertEqual(inventory.parked, 2)
        XCTAssertEqual(inventory.queued, 2)
        XCTAssertEqual(inventory.active, 2)
        XCTAssertEqual(snapshot.rows(for: .waiting, nowMs: 1_000_000_000).count, inventory.queued)
    }

    func testDoneSectionUsesCompletedIdentifiers() throws {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "status", withExtension: "json"))
        let data = try Data(contentsOf: url)
        let snapshot = try JSONDecoder().decode(OrchestratorSnapshot.self, from: data)

        let doneRows = snapshot.rows(for: .done, nowMs: 20_000)
        XCTAssertEqual(doneRows.map(\.identifier), ["ANM-99"])
        XCTAssertEqual(doneRows.first?.status, "completed")
        XCTAssertEqual(snapshot.agentInventory(nowMs: 20_000).completed, 1)
    }

    func testUsageLimitErrorsAreRateLimited() {
        XCTAssertTrue(isRateLimitedError("codex_rate_limited"))
        XCTAssertTrue(isRateLimitedError("{\"message\":\"You've hit your usage limit.\",\"codexErrorInfo\":\"usageLimitExceeded\"}"))
        XCTAssertFalse(isRateLimitedError("network timeout"))
    }

    func testSummarizeCodexMessageHandlesPlainText() {
        XCTAssertEqual(summarizeCodexMessage("hello"), "hello")
    }

    func testSummarizeRetryErrorParsesJsonMessage() {
        let message = summarizeRetryError("{\"message\":\"You've hit your usage limit.\"}")
        XCTAssertEqual(message, "You've hit your usage limit.")
    }

    func testLinearIssueURL() {
        XCTAssertEqual(
            linearIssueURL(for: "ANM-42", orgSlug: "anmho")?.absoluteString,
            "https://linear.app/anmho/issue/ANM-42"
        )
        XCTAssertNil(linearIssueURL(for: "bad-id", orgSlug: "anmho"))
    }
}
