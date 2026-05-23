import type { RateLimitGateState } from "./types.js";

export interface RateLimitWindow {
  usedPercent?: number;
  resetsAt?: number | null;
  windowDurationMins?: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  limitName?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  rateLimitReachedType?: string | null;
}

export function resetSecondsToMs(resetsAtSeconds: number | null | undefined): number | null {
  if (typeof resetsAtSeconds !== "number" || !Number.isFinite(resetsAtSeconds)) {
    return null;
  }
  return Math.max(0, Math.trunc(resetsAtSeconds * 1000));
}

export function rateLimitUntilFromSnapshot(snapshot: RateLimitSnapshot | null | undefined): number | null {
  if (!snapshot) {
    return null;
  }

  const windows = [snapshot.primary, snapshot.secondary].filter(Boolean) as RateLimitWindow[];
  const reached = Boolean(snapshot.rateLimitReachedType);
  const exhausted = windows.some((window) => typeof window.usedPercent === "number" && window.usedPercent >= 100);
  if (!reached && !exhausted) {
    return null;
  }

  const resetTimes = windows
    .map((window) => resetSecondsToMs(window.resetsAt))
    .filter((value): value is number => value !== null);

  if (resetTimes.length === 0) {
    return null;
  }

  return Math.max(...resetTimes);
}

export function mergeGateState(
  current: RateLimitGateState,
  resumeAfterMs: number,
  reason: string,
  updatedAtMs = Date.now()
): RateLimitGateState {
  if (current.resumeAfterMs && current.resumeAfterMs >= resumeAfterMs) {
    return current;
  }

  return {
    resumeAfterMs,
    reason,
    updatedAtMs
  };
}

export function isGateParked(state: RateLimitGateState, nowMs = Date.now()): boolean {
  return typeof state.resumeAfterMs === "number" && state.resumeAfterMs > nowMs;
}
