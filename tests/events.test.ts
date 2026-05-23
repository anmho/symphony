import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AgentWorkEventStore, workEventFromCodexEvent } from "../src/events.js";

describe("agent work events", () => {
  it("persists events as cursor-addressable JSONL and redacts secrets", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-events-"));
    const store = new AgentWorkEventStore(path.join(dir, "WORKFLOW.md"), () => 1000);

    store.append({
      issueId: "issue-1",
      identifier: "ANM-1",
      repoKey: "symphony",
      workspacePath: "/tmp/workspaces/ANM-1",
      threadId: "thread-1",
      turnId: "turn-1",
      type: "assistant_delta",
      summary: "using token lin_abcdefghijklmnopqrstuvwxyz",
      payload: {
        api_key: "lin_abcdefghijklmnopqrstuvwxyz",
        nested: {
          message: "hello"
        }
      }
    });

    const events = store.query({ issue: "ANM-1", cursor: 0, limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0]?.cursor).toBe(1);
    expect(events[0]?.summary).toContain("[REDACTED]");
    expect(events[0]?.payload).toMatchObject({
      api_key: "[REDACTED]",
      nested: {
        message: "hello"
      }
    });
  });

  it("normalizes reasoning notifications without exposing hidden content", () => {
    const normalized = workEventFromCodexEvent(
      {
        issueId: "issue-1",
        identifier: "ANM-1",
        repoKey: null,
        workspacePath: null,
        threadId: "thread-1",
        turnId: "turn-1"
      },
      {
        type: "notification",
        method: "item/completed",
        params: {
          item: {
            type: "reasoning",
            text: "private internal reasoning",
            summary: "considered the test failure"
          }
        }
      }
    );

    expect(normalized).toMatchObject({
      type: "reasoning_summary",
      summary: "considered the test failure"
    });
    expect(JSON.stringify(normalized.payload)).not.toContain("private internal reasoning");
  });

  it("persists queued steering until consumed", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-steer-"));
    const workflowPath = path.join(dir, "WORKFLOW.md");
    const store = new AgentWorkEventStore(workflowPath, () => 1000);

    store.queueSteer("ANM-1", "focus the manifest test");

    const reloaded = new AgentWorkEventStore(workflowPath, () => 2000);
    expect(reloaded.queuedSteerCount("ANM-1")).toBe(1);
    expect(reloaded.consumeSteer("ANM-1")?.text).toBe("focus the manifest test");
    expect(reloaded.queuedSteerCount("ANM-1")).toBe(0);
  });
});
