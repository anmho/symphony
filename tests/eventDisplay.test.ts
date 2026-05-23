import { describe, expect, it } from "vitest";
import {
  StreamingEventDisplay,
  applyLogViewportKey,
  buildLogLines,
  compactAgentWorkEvents,
  formatDisplayEvent,
  isHiddenFromHumanView
} from "../src/eventDisplay.js";
import type { AgentWorkEvent } from "../src/types.js";

describe("event display compaction", () => {
  it("merges adjacent assistant deltas into one assistant row", () => {
    const events = [
      makeEvent({ cursor: 1, type: "assistant_delta", summary: "Hel", turnId: "turn-1", payload: { itemId: "item-1", delta: "Hel" } }),
      makeEvent({ cursor: 2, type: "assistant_delta", summary: "lo", turnId: "turn-1", payload: { itemId: "item-1", delta: "lo" } })
    ];

    expect(compactAgentWorkEvents(events)).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Hello",
        sourceCount: 2
      })
    ]);
  });

  it("prefers completed assistant messages over streamed deltas", () => {
    const events = [
      makeEvent({ cursor: 1, type: "assistant_delta", summary: "partial", turnId: "turn-1", payload: { itemId: "item-1" } }),
      makeEvent({
        cursor: 2,
        type: "assistant_message",
        summary: "assistant message",
        turnId: "turn-1",
        payload: { itemId: "item-1", item: { type: "agentMessage", text: "Done" } }
      })
    ];

    expect(compactAgentWorkEvents(events)).toEqual([
      expect.objectContaining({
        kind: "assistant",
        text: "Done",
        sourceCount: 2
      })
    ]);
  });

  it("keeps command, error, and rate-limit events separate", () => {
    const events = [
      makeEvent({ cursor: 1, type: "command", summary: "running: bun test" }),
      makeEvent({ cursor: 2, type: "error", level: "error", summary: "tool failed" }),
      makeEvent({ cursor: 3, type: "rate_limited", level: "warn", summary: "codex rate limited" })
    ];

    const compacted = compactAgentWorkEvents(events);
    expect(compacted.map((event) => event.kind)).toEqual(["command", "error", "rate-limit"]);
  });

  it("hides noisy notifications from human views", () => {
    const events = [
      makeEvent({ cursor: 1, type: "notification", summary: "skills/changed" }),
      makeEvent({ cursor: 2, type: "command", summary: "completed: ls" })
    ];

    expect(isHiddenFromHumanView(events[0]!)).toBe(true);
    expect(compactAgentWorkEvents(events)).toEqual([
      expect.objectContaining({ kind: "command", text: "completed: ls" })
    ]);
  });

  it("streams compacted output for follow mode without emitting partial deltas", () => {
    const display = new StreamingEventDisplay();
    expect(display.push(makeEvent({ cursor: 1, type: "assistant_delta", summary: "A", payload: { itemId: "item-1" } }))).toEqual([]);
    expect(display.push(makeEvent({ cursor: 2, type: "assistant_delta", summary: "B", payload: { itemId: "item-1" } }))).toEqual([]);
    expect(display.push(makeEvent({ cursor: 3, type: "command", summary: "ls" }))).toEqual([
      expect.objectContaining({ kind: "assistant", text: "AB" }),
      expect.objectContaining({ kind: "command", text: "ls" })
    ]);
  });

  it("formats concise human labels", () => {
    const line = formatDisplayEvent({
      cursor: 1,
      timestampMs: Date.parse("2026-05-23T15:04:46.161Z"),
      turnId: "turn-1",
      level: "info",
      kind: "assistant",
      text: "Working on it",
      sourceCount: 1
    });

    expect(line).toMatch(/^15:04:46 +assistant +Working on it$/);
  });
});

describe("log viewport", () => {
  it("changes wrapped line count without changing source events", () => {
    const events = [
      makeEvent({
        cursor: 1,
        type: "assistant_message",
        summary: "one two three four five six seven eight nine ten",
        payload: { item: { text: "one two three four five six seven eight nine ten" } }
      })
    ];
    const unwrapped = buildLogLines(events, 120, false);
    const wrapped = buildLogLines(events, 12, true);

    expect(unwrapped).toHaveLength(1);
    expect(wrapped.length).toBeGreaterThan(1);
  });

  it("disables follow when scrolling up and re-enables at bottom", () => {
    const lines = Array.from({ length: 30 }, (_, index) => `line-${index}`);
    let viewport = {
      scrollTop: 29,
      selectedLine: 29,
      follow: true,
      wrap: false
    };

    viewport = applyLogViewportKey(viewport, "up", lines.length, 10);
    expect(viewport.follow).toBe(false);
    expect(viewport.selectedLine).toBeLessThan(29);

    viewport = applyLogViewportKey(viewport, "bottom", lines.length, 10);
    expect(viewport.follow).toBe(true);
    expect(viewport.scrollTop).toBe(20);
    expect(viewport.selectedLine).toBe(29);
  });

  it("moves a page at a time", () => {
    let viewport = {
      scrollTop: 0,
      selectedLine: 0,
      follow: false,
      wrap: false
    };

    viewport = applyLogViewportKey(viewport, "pagedown", 40, 10);
    expect(viewport.scrollTop).toBe(10);
    viewport = applyLogViewportKey(viewport, "pageup", 40, 10);
    expect(viewport.scrollTop).toBe(0);
  });
});

function makeEvent(overrides: Partial<AgentWorkEvent> & Pick<AgentWorkEvent, "cursor" | "type" | "summary">): AgentWorkEvent {
  return {
    cursor: overrides.cursor,
    timestampMs: overrides.timestampMs ?? 1_000,
    issueId: overrides.issueId ?? "issue-1",
    identifier: overrides.identifier ?? "ANM-1",
    repoKey: overrides.repoKey ?? null,
    workspacePath: overrides.workspacePath ?? null,
    threadId: overrides.threadId ?? "thread-1",
    turnId: overrides.turnId ?? null,
    type: overrides.type,
    level: overrides.level ?? "info",
    summary: overrides.summary,
    payload: overrides.payload ?? null
  };
}
