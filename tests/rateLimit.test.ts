import { describe, expect, it } from "vitest";
import { isGateParked, isRateLimitError, mergeGateState, rateLimitUntilFromSnapshot } from "../src/rateLimit.js";

describe("rate limits", () => {
  it("extracts the farthest reset from exhausted windows", () => {
    expect(
      rateLimitUntilFromSnapshot({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, resetsAt: 100 },
        secondary: { usedPercent: 75, resetsAt: 200 }
      })
    ).toBe(200000);
  });

  it("keeps the latest gate window", () => {
    const current = { resumeAfterMs: 1000, reason: "old", updatedAtMs: 1 };
    expect(mergeGateState(current, 500, "new", 2)).toBe(current);
    expect(mergeGateState(current, 2000, "new", 2)).toEqual({
      resumeAfterMs: 2000,
      reason: "new",
      updatedAtMs: 2
    });
  });

  it("detects parked and unparked gate states", () => {
    expect(isGateParked({ resumeAfterMs: 2000, reason: null, updatedAtMs: null }, 1000)).toBe(true);
    expect(isGateParked({ resumeAfterMs: 2000, reason: null, updatedAtMs: null }, 3000)).toBe(false);
  });

  it("detects structured Codex usage-limit errors", () => {
    expect(isRateLimitError("codex_rate_limited")).toBe(true);
    expect(isRateLimitError("{\"codexErrorInfo\":\"usageLimitExceeded\"}")).toBe(true);
    expect(isRateLimitError("You've hit your usage limit.")).toBe(true);
    expect(isRateLimitError("ordinary failure")).toBe(false);
  });
});
