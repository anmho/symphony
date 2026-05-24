import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_VIEWPORT,
  applyLogViewportKey,
  buildLogLines
} from "../src/eventDisplay.js";
import { renderLogSection, renderStatusScreen, watchLogKey } from "../src/watch.js";
import type { AgentWorkEvent, OrchestratorSnapshot } from "../src/types.js";

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

  it("renders compacted logs in the events view", () => {
    const events = makeLogEvents();
    const section = renderLogSection(events, { ...DEFAULT_LOG_VIEWPORT }, 8, 100, {
      dim: (value) => value,
      title: (value) => value,
      accent: (value) => value,
      warn: (value) => value,
      error: (value) => value,
      ok: (value) => value,
      header: (value) => value,
      selected: (value) => value,
      status: (_kind, value) => value
    });

    const screen = renderStatusScreen(makeSnapshot(), {
      nowMs: 20_000,
      port: 3979,
      selectedIndex: 0,
      view: "events",
      events,
      logLines: section.lines,
      logViewport: section.viewport
    });

    expect(screen).toContain("LOGS");
    expect(screen).toContain("assistant");
    expect(screen).toContain("Hello");
    expect(screen).not.toContain("assistant_delta");
  });

  it("maps log scroll keys only in logs view", () => {
    expect(watchLogKey({ name: "j" })).toBe("down");
    expect(watchLogKey({ name: "k" })).toBe("up");
    expect(watchLogKey({ name: "pageup" })).toBe("pageup");
    expect(watchLogKey({ name: "g", shift: false })).toBe("top");
    expect(watchLogKey({ name: "g", shift: true })).toBe("bottom");
    expect(watchLogKey({ name: "f" })).toBe("toggle-follow");
  });

  it("scroll keys move the log viewport rather than changing rendered line count", () => {
    const events = makeLogEvents();
    const lines = buildLogLines(events, 100, false);
    const scrolled = applyLogViewportKey(
      { scrollTop: 0, selectedLine: 0, follow: true, wrap: false },
      "up",
      lines.length,
      4
    );

    expect(scrolled.follow).toBe(false);
    expect(scrolled.selectedLine).toBe(0);
    expect(lines).toHaveLength(2);
  });
});

function makeLogEvents(): AgentWorkEvent[] {
  return [
    {
      cursor: 1,
      timestampMs: 12_500,
      issueId: "issue-1",
      identifier: "ANM-1",
      repoKey: null,
      workspacePath: null,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "assistant_delta",
      level: "info",
      summary: "Hel",
      payload: { itemId: "item-1", delta: "Hel" }
    },
    {
      cursor: 2,
      timestampMs: 12_600,
      issueId: "issue-1",
      identifier: "ANM-1",
      repoKey: null,
      workspacePath: null,
      threadId: "thread-1",
      turnId: "turn-1",
      type: "assistant_delta",
      level: "info",
      summary: "lo",
      payload: { itemId: "item-1", delta: "lo" }
    },
    {
      cursor: 3,
      timestampMs: 12_700,
      issueId: "issue-1",
      identifier: "ANM-1",
      repoKey: null,
      workspacePath: null,
      threadId: "thread-1",
      turnId: null,
      type: "command",
      level: "info",
      summary: "completed: bun test",
      payload: null
    }
  ];
}

function makeSnapshot(): OrchestratorSnapshot {
  return {
    startedAtMs: 10_000,
    workflowPath: "/tmp/WORKFLOW.md",
    running: [
      {
        issueId: "issue-1",
        identifier: "ANM-1",
        title: "Example Symphony issue",
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
