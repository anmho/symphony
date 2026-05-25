import type { AgentWorkEvent, AgentWorkEventType } from "./types.js";

export type DisplayEventKind =
  | "assistant"
  | "command"
  | "tool"
  | "error"
  | "rate-limit"
  | "runner"
  | "diff"
  | "goal"
  | "reasoning"
  | "other";

export interface DisplayEvent {
  cursor: number;
  timestampMs: number;
  turnId: string | null;
  level: AgentWorkEvent["level"];
  kind: DisplayEventKind;
  text: string;
  sourceCount: number;
}

export interface CurrentWorkSummary {
  kind: DisplayEventKind;
  text: string;
  updatedAtMs: number;
  cursor: number;
}

const HIDDEN_NOTIFICATIONS = [
  "hook/completed",
  "hook/started",
  "item/completed",
  "item/started",
  "mcpserver/startupstatus/updated",
  "serverrequest/resolved",
  "skills/changed"
];

const HIDDEN_RUNNER_SUMMARIES = [
  "codex app-server wrote "
];

export function isHiddenFromHumanView(event: AgentWorkEvent): boolean {
  if (event.type === "notification") {
    const method = event.summary.toLowerCase();
    return HIDDEN_NOTIFICATIONS.some((needle) => method.includes(needle));
  }
  if (event.type === "stderr") {
    const summary = event.summary.toLowerCase();
    return HIDDEN_RUNNER_SUMMARIES.some((needle) => summary.includes(needle));
  }
  return false;
}

export function compactAgentWorkEvents(events: AgentWorkEvent[]): DisplayEvent[] {
  const visible = events.filter((event) => !isHiddenFromHumanView(event));
  const output: DisplayEvent[] = [];
  let pending: PendingAssistantStream | null = null;

  const flushPending = () => {
    if (!pending) {
      return;
    }
    output.push(pendingToDisplay(pending));
    pending = null;
  };

  for (const event of visible) {
    if (event.type === "assistant_delta") {
      const key = assistantStreamKey(event);
      if (pending && pending.key === key) {
        pending.append(event);
      } else {
        flushPending();
        pending = PendingAssistantStream.start(event, key);
      }
      continue;
    }

    if (event.type === "assistant_message") {
      const key = assistantStreamKey(event);
      if (pending && pending.key === key) {
        pending.complete(event);
        flushPending();
      } else {
        flushPending();
        output.push(eventToDisplay(event));
      }
      continue;
    }

    flushPending();
    output.push(eventToDisplay(event));
  }

  flushPending();
  return output;
}

export function formatDisplayEvent(event: DisplayEvent, options: { includeIssue?: string } = {}): string {
  const time = new Date(event.timestampMs).toISOString().slice(11, 19);
  const prefix = options.includeIssue ? `${options.includeIssue} ` : "";
  const label = padDisplayKind(event.kind, 11);
  return `${time} ${prefix}${label} ${event.text}`;
}

export function summarizeCurrentWork(events: AgentWorkEvent[]): CurrentWorkSummary | null {
  const compacted = compactAgentWorkEvents(events);
  for (let index = compacted.length - 1; index >= 0; index -= 1) {
    const event = compacted[index]!;
    if (event.kind === "runner" || event.kind === "other") {
      continue;
    }
    const text = currentWorkText(event);
    if (!text) {
      continue;
    }
    return {
      kind: event.kind,
      text,
      updatedAtMs: event.timestampMs,
      cursor: event.cursor
    };
  }
  return null;
}


interface PendingAssistantStream {
  key: string;
  cursor: number;
  timestampMs: number;
  turnId: string | null;
  level: AgentWorkEvent["level"];
  parts: string[];
  sourceCount: number;
  append(event: AgentWorkEvent): void;
  complete(event: AgentWorkEvent): void;
}

const PendingAssistantStream = {
  start(event: AgentWorkEvent, key: string): PendingAssistantStream {
    const stream: PendingAssistantStream = {
      key,
      cursor: event.cursor,
      timestampMs: event.timestampMs,
      turnId: event.turnId,
      level: event.level,
      parts: [],
      sourceCount: 0,
      append(deltaEvent) {
        this.cursor = deltaEvent.cursor;
        this.parts.push(deltaEvent.summary);
        this.sourceCount += 1;
      },
      complete(messageEvent) {
        const messageText = assistantMessageText(messageEvent);
        if (messageText) {
          this.parts = [messageText];
        }
        this.cursor = messageEvent.cursor;
        this.sourceCount += 1;
      }
    };
    stream.append(event);
    return stream;
  }
};

function pendingToDisplay(pending: PendingAssistantStream): DisplayEvent {
  return {
    cursor: pending.cursor,
    timestampMs: pending.timestampMs,
    turnId: pending.turnId,
    level: pending.level,
    kind: "assistant",
    text: pending.parts.join("").trim() || "(empty assistant message)",
    sourceCount: pending.sourceCount
  };
}

function currentWorkText(event: DisplayEvent): string | null {
  const text = squashWhitespace(event.text);
  if (!text) {
    return null;
  }
  if (event.kind === "command") {
    if (text.startsWith("inProgress: ")) {
      return `Running command: ${text.slice("inProgress: ".length)}`;
    }
    if (text.startsWith("completed: ")) {
      return `Completed command: ${text.slice("completed: ".length)}`;
    }
    if (text.startsWith("failed: ")) {
      return `Command failed: ${text.slice("failed: ".length)}`;
    }
  }
  if (event.kind === "assistant") {
    return text === "assistant message" ? null : clipText(text, 220);
  }
  if (event.kind === "reasoning") {
    return text === "reasoning summary event" ? null : clipText(text, 220);
  }
  if (event.kind === "goal") {
    return summarizeGoalText(text);
  }
  return clipText(text, 220);
}

function summarizeGoalText(text: string): string {
  const match = text.match(/^goal\s+([^:]+):\s+(.+?)(?:\.\s+Satisfy the issue.*)?(?:\s+\(tokens=.*)?$/i);
  if (!match) {
    return clipText(text, 180);
  }
  const status = match[1]?.trim() || "updated";
  const objective = squashWhitespace(match[2] ?? "");
  if (status.toLowerCase() === "active") {
    return "Goal active";
  }
  return clipText(`Goal ${status}: ${objective}`, 180);
}

function squashWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clipText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(maxLength - 3, 0)).trimEnd()}...`;
}

function eventToDisplay(event: AgentWorkEvent): DisplayEvent {
  return {
    cursor: event.cursor,
    timestampMs: event.timestampMs,
    turnId: event.turnId,
    level: event.level,
    kind: displayKindForType(event.type),
    text: displayTextForEvent(event),
    sourceCount: 1
  };
}

function displayKindForType(type: AgentWorkEventType): DisplayEventKind {
  switch (type) {
    case "assistant_delta":
    case "assistant_message":
      return "assistant";
    case "command":
      return "command";
    case "tool":
      return "tool";
    case "error":
      return "error";
    case "rate_limited":
      return "rate-limit";
    case "runner":
    case "process":
    case "stderr":
    case "thread":
    case "turn":
      return "runner";
    case "diff":
      return "diff";
    case "goal":
      return "goal";
    case "reasoning_summary":
      return "reasoning";
    default:
      return "other";
  }
}

function displayTextForEvent(event: AgentWorkEvent): string {
  if (event.type === "assistant_message") {
    return assistantMessageText(event) ?? event.summary;
  }
  if (event.type === "reasoning_summary") {
    return event.summary;
  }
  if (event.type === "notification") {
    return event.summary;
  }
  return event.summary;
}

function assistantMessageText(event: AgentWorkEvent): string | null {
  const item = event.payload?.item;
  if (item && typeof item === "object") {
    const record = item as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : typeof record.content === "string" ? record.content : null;
    if (text?.trim()) {
      return text;
    }
  }
  if (event.summary.trim() && event.summary !== "assistant message") {
    return event.summary;
  }
  return null;
}

function assistantStreamKey(event: AgentWorkEvent): string {
  const payload = event.payload;
  const item = payload?.item;
  const itemRecord = item && typeof item === "object" ? item as Record<string, unknown> : null;
  const itemId =
    (typeof payload?.itemId === "string" ? payload.itemId : null) ??
    (typeof itemRecord?.id === "string" ? itemRecord.id : null) ??
    "";
  return `${event.issueId}|${event.turnId ?? ""}|${itemId}`;
}

function padDisplayKind(kind: DisplayEventKind, width: number): string {
  const label = kind === "rate-limit" ? "rate-limit" : kind;
  return label.length >= width ? label.slice(0, width) : label.padEnd(width, " ");
}

export interface LogViewportState {
  scrollTop: number;
  selectedLine: number;
  follow: boolean;
  wrap: boolean;
}

export const DEFAULT_LOG_VIEWPORT: LogViewportState = {
  scrollTop: 0,
  selectedLine: 0,
  follow: true,
  wrap: false
};

export function buildLogLines(events: AgentWorkEvent[], wrapWidth: number, wrap: boolean): string[] {
  const compacted = compactAgentWorkEvents(events);
  if (!wrap || wrapWidth <= 0) {
    return compacted.map((event) => formatDisplayEvent(event));
  }
  return compacted.flatMap((event) => wrapDisplayLine(formatDisplayEvent(event), wrapWidth));
}

export function wrapDisplayLine(line: string, width: number): string[] {
  if (width <= 0 || line.length <= width) {
    return [line];
  }
  const lines: string[] = [];
  let remaining = line;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) {
      breakAt = width;
    }
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) {
    lines.push(remaining);
  }
  return lines.length > 0 ? lines : [""];
}

export function visibleLogWindow(
  lines: string[],
  viewport: LogViewportState,
  viewportHeight: number
): { lines: string[]; scrollTop: number; selectedLine: number } {
  const maxScroll = Math.max(lines.length - viewportHeight, 0);
  let scrollTop = viewport.scrollTop;
  let selectedLine = viewport.selectedLine;

  if (viewport.follow) {
    scrollTop = maxScroll;
    selectedLine = Math.max(lines.length - 1, 0);
  } else {
    scrollTop = clamp(scrollTop, 0, maxScroll);
    selectedLine = clamp(selectedLine, scrollTop, scrollTop + Math.max(viewportHeight - 1, 0));
  }

  return {
    scrollTop,
    selectedLine,
    lines: lines.slice(scrollTop, scrollTop + viewportHeight)
  };
}

export type LogViewportKey =
  | "up"
  | "down"
  | "pageup"
  | "pagedown"
  | "top"
  | "bottom"
  | "toggle-follow";

export function applyLogViewportKey(
  viewport: LogViewportState,
  key: LogViewportKey,
  lineCount: number,
  viewportHeight: number
): LogViewportState {
  const maxScroll = Math.max(lineCount - viewportHeight, 0);
  const maxLine = Math.max(lineCount - 1, 0);
  const next = { ...viewport };

  switch (key) {
    case "up":
      next.follow = false;
      if (next.selectedLine > 0) {
        next.selectedLine -= 1;
        if (next.selectedLine < next.scrollTop) {
          next.scrollTop = next.selectedLine;
        }
      } else {
        next.scrollTop = Math.max(next.scrollTop - 1, 0);
        next.selectedLine = next.scrollTop;
      }
      break;
    case "down":
      next.follow = false;
      if (next.selectedLine < maxLine) {
        next.selectedLine += 1;
        if (next.selectedLine >= next.scrollTop + viewportHeight) {
          next.scrollTop = Math.min(next.selectedLine - viewportHeight + 1, maxScroll);
        }
      } else {
        next.scrollTop = Math.min(next.scrollTop + 1, maxScroll);
        next.selectedLine = Math.min(next.scrollTop + viewportHeight - 1, maxLine);
      }
      break;
    case "pageup":
      next.follow = false;
      next.scrollTop = Math.max(next.scrollTop - viewportHeight, 0);
      next.selectedLine = next.scrollTop;
      break;
    case "pagedown":
      next.follow = false;
      next.scrollTop = Math.min(next.scrollTop + viewportHeight, maxScroll);
      next.selectedLine = Math.min(next.scrollTop + viewportHeight - 1, maxLine);
      break;
    case "top":
      next.follow = false;
      next.scrollTop = 0;
      next.selectedLine = 0;
      break;
    case "bottom":
      next.follow = true;
      next.scrollTop = maxScroll;
      next.selectedLine = maxLine;
      break;
    case "toggle-follow":
      next.follow = !next.follow;
      if (next.follow) {
        next.scrollTop = maxScroll;
        next.selectedLine = maxLine;
      }
      break;
  }

  next.scrollTop = clamp(next.scrollTop, 0, maxScroll);
  next.selectedLine = clamp(next.selectedLine, 0, maxLine);
  return next;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class StreamingEventDisplay {
  private pending: PendingAssistantStream | null = null;

  push(event: AgentWorkEvent): DisplayEvent[] {
    if (isHiddenFromHumanView(event)) {
      return [];
    }
    if (event.type === "assistant_delta") {
      const key = assistantStreamKey(event);
      if (this.pending && this.pending.key === key) {
        this.pending.append(event);
      } else {
        return this.replacePending(PendingAssistantStream.start(event, key));
      }
      return [];
    }
    if (event.type === "assistant_message") {
      const key = assistantStreamKey(event);
      if (this.pending && this.pending.key === key) {
        this.pending.complete(event);
        return this.drainPending();
      }
      return [eventToDisplay(event)];
    }
    return [...this.drainPending(), eventToDisplay(event)];
  }

  flush(): DisplayEvent[] {
    return this.drainPending();
  }

  private replacePending(pending: PendingAssistantStream): DisplayEvent[] {
    const flushed = this.drainPending();
    this.pending = pending;
    return flushed;
  }

  private drainPending(): DisplayEvent[] {
    if (!this.pending) {
      return [];
    }
    const display = pendingToDisplay(this.pending);
    this.pending = null;
    return [display];
  }
}
