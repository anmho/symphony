import { describe, expect, it } from "vitest";
import { renderStatusScreen } from "../src/watch.js";
import type { OrchestratorSnapshot } from "../src/types.js";

describe("watch", () => {
  it("renders a k9s-style agent table", () => {
    const screen = renderStatusScreen(makeSnapshot(), {
      nowMs: 20_000,
      port: 3979,
      selectedIndex: 0
    });

    expect(screen).toContain("symphony@local");
    expect(screen).toContain("<a> Agents");
    expect(screen).toContain("ISSUE");
    expect(screen).toContain("ANM-1");
    expect(screen).toContain("running");
  });

  it("renders help and filter modes", () => {
    const help = renderStatusScreen(makeSnapshot(), {
      nowMs: 20_000,
      port: 3979,
      selectedIndex: 0,
      view: "help"
    });
    const filtered = renderStatusScreen(makeSnapshot(), {
      nowMs: 20_000,
      port: 3979,
      selectedIndex: 0,
      inputMode: "filter",
      commandBuffer: "ANM",
      filterText: "ANM"
    });

    expect(help).toContain(":agents");
    expect(help).toContain(":describe");
    expect(filtered).toContain("/ANM");
    expect(filtered).toContain("filter=ANM");
  });

  it("can render colored terminal output", () => {
    const screen = renderStatusScreen(makeSnapshot(), {
      nowMs: 20_000,
      port: 3979,
      selectedIndex: 0,
      color: true
    });

    expect(screen).toContain("\x1b[1;36m");
    expect(screen).toContain("\x1b[7m");
  });
});

function makeSnapshot(): OrchestratorSnapshot {
  return {
    startedAtMs: 10_000,
    workflowPath: "/tmp/WORKFLOW.md",
    running: [
      {
        issueId: "issue-1",
        identifier: "ANM-1",
        repoKey: null,
        workspacePath: "/tmp/workspaces/ANM-1",
        eventLogPath: "/tmp/.symphony/events/ANM-1.jsonl",
        latestEventCursor: 1,
        queuedSteerCount: 0,
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: 123,
        lastCodexEvent: "notification",
        lastCodexTimestamp: 19_000,
        lastCodexMessage: JSON.stringify({
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              text: "Working"
            }
          }
        }),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        turnCount: 1,
        startedAtMs: 12_000
      }
    ],
    claimed: ["issue-1"],
    retryAttempts: [],
    completed: [],
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      runtimeMs: 0
    },
    codexRateLimit: {
      resumeAfterMs: null,
      reason: null,
      updatedAtMs: null
    },
    lastTickAtMs: 19_500,
    lastConfigError: null
  };
}
