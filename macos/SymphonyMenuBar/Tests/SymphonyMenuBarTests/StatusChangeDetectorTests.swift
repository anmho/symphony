import Foundation
import SymphonyMenuBarCore
import XCTest

final class StatusChangeDetectorTests: XCTestCase {
    func testSkipsInitialSnapshot() {
        let current = MonitorState(
            isOnline: true,
            running: ["ANM-1"],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )
        XCTAssertTrue(StatusChangeDetector.changes(from: nil, to: current).isEmpty)
    }

    func testDetectsRateLimitStartedAndCleared() {
        let before = MonitorState(
            isOnline: true,
            running: ["ANM-1"],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )
        let limited = MonitorState(
            isOnline: true,
            running: [],
            retrying: [],
            parked: ["ANM-1"],
            completed: [],
            rateLimited: true,
            configError: nil
        )
        let cleared = MonitorState(
            isOnline: true,
            running: ["ANM-1"],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )

        let started = StatusChangeDetector.changes(from: before, to: limited)
        XCTAssertTrue(started.contains(where: { $0.identifier == "symphony.rate_limit.on" }))
        XCTAssertTrue(started.contains(where: { $0.identifier == "agent.parked.ANM-1" }))

        let ended = StatusChangeDetector.changes(from: limited, to: cleared)
        XCTAssertTrue(ended.contains(where: { $0.identifier == "symphony.rate_limit.off" }))
        XCTAssertTrue(ended.contains(where: { $0.identifier == "agent.started.ANM-1" }))
    }

    func testDetectsAgentFinished() {
        let before = MonitorState(
            isOnline: true,
            running: ["ANM-2"],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )
        let after = MonitorState(
            isOnline: true,
            running: [],
            retrying: [],
            parked: [],
            completed: ["ANM-2"],
            rateLimited: false,
            configError: nil
        )

        let changes = StatusChangeDetector.changes(from: before, to: after)
        XCTAssertTrue(changes.contains(where: { $0.identifier == "agent.completed.ANM-2" }))
    }

    func testDetectsOfflineTransition() {
        let before = MonitorState(
            isOnline: true,
            running: ["ANM-3"],
            retrying: [],
            parked: [],
            completed: [],
            rateLimited: false,
            configError: nil
        )

        let changes = StatusChangeDetector.changes(from: before, to: .offline())
        XCTAssertEqual(changes.map(\.identifier), ["symphony.offline"])
    }
}
