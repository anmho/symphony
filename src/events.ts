import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type {
  AgentWorkEvent,
  AgentWorkEventType,
  AgentRunEvent,
  JsonObject,
  QueuedSteer
} from "./types.js";

export interface AgentWorkContext {
  issueId: string;
  identifier: string;
  repoKey: string | null;
  workspacePath: string | null;
  threadId: string | null;
  turnId: string | null;
}

export interface AppendAgentWorkEventInput extends AgentWorkContext {
  type: AgentWorkEventType;
  level?: AgentWorkEvent["level"];
  summary: string;
  payload?: JsonObject | null;
  timestampMs?: number;
}

export interface EventQuery {
  issue?: string | null;
  cursor?: number | null;
  limit?: number | null;
}

export class AgentWorkEventStore {
  private readonly eventDir: string;
  private readonly stateDir: string;
  private readonly steeringPath: string;
  private readonly buffers = new Map<string, AgentWorkEvent[]>();
  private readonly latestByIdentifier = new Map<string, number>();
  private readonly queuedSteering = new Map<string, QueuedSteer>();
  private nextCursor = 1;

  constructor(workflowPath: string, private readonly now: () => number = Date.now) {
    const projectStateDir = path.join(path.dirname(path.resolve(workflowPath)), ".symphony");
    this.eventDir = path.join(projectStateDir, "events");
    this.stateDir = path.join(projectStateDir, "state");
    this.steeringPath = path.join(this.stateDir, "steering.json");
    this.loadExistingCursors();
    this.loadQueuedSteering();
  }

  append(input: AppendAgentWorkEventInput): AgentWorkEvent {
    mkdirSync(this.eventDir, { recursive: true });
    const event: AgentWorkEvent = {
      cursor: this.nextCursor,
      timestampMs: input.timestampMs ?? this.now(),
      issueId: input.issueId,
      identifier: input.identifier,
      repoKey: input.repoKey,
      workspacePath: input.workspacePath,
      threadId: input.threadId,
      turnId: input.turnId,
      type: input.type,
      level: input.level ?? "info",
      summary: redact(input.summary).slice(0, 4000),
      payload: input.payload ? redactJson(input.payload) : null
    };
    this.nextCursor += 1;
    this.latestByIdentifier.set(event.identifier, event.cursor);

    const buffer = this.buffers.get(event.identifier) ?? [];
    buffer.push(event);
    if (buffer.length > 500) {
      buffer.splice(0, buffer.length - 500);
    }
    this.buffers.set(event.identifier, buffer);

    appendFileSync(this.logPathForIssue(event.identifier), `${JSON.stringify(event)}\n`);
    return event;
  }

  logPathForIssue(identifier: string): string {
    return path.join(this.eventDir, `${sanitizeFilename(identifier)}.jsonl`);
  }

  latestCursorForIssue(identifier: string): number | null {
    return this.latestByIdentifier.get(identifier) ?? null;
  }

  query(query: EventQuery = {}): AgentWorkEvent[] {
    const limit = clampLimit(query.limit ?? 100);
    const cursor = query.cursor ?? 0;
    const events = query.issue
      ? this.readIssueEvents(query.issue)
      : this.readAllEvents();
    return events
      .filter((event) => event.cursor > cursor)
      .sort((left, right) => left.cursor - right.cursor)
      .slice(-limit);
  }

  queueSteer(issue: string, text: string): QueuedSteer {
    const steer: QueuedSteer = {
      issue,
      text: redact(text).slice(0, 8000),
      queuedAtMs: this.now()
    };
    this.queuedSteering.set(issue, steer);
    this.persistQueuedSteering();
    return steer;
  }

  consumeSteer(issue: string): QueuedSteer | null {
    const steer = this.queuedSteering.get(issue) ?? null;
    if (steer) {
      this.queuedSteering.delete(issue);
      this.persistQueuedSteering();
    }
    return steer;
  }

  queuedSteerCount(issue: string): number {
    return this.queuedSteering.has(issue) ? 1 : 0;
  }

  private readIssueEvents(issue: string): AgentWorkEvent[] {
    const buffered = this.buffers.get(issue);
    const filePath = this.logPathForIssue(issue);
    if (!existsSync(filePath)) {
      return buffered ? [...buffered] : [];
    }
    return parseJsonl(readFileSync(filePath, "utf8"));
  }

  private readAllEvents(): AgentWorkEvent[] {
    if (!existsSync(this.eventDir)) {
      return [];
    }
    return readdirSync(this.eventDir)
      .filter((file) => file.endsWith(".jsonl"))
      .flatMap((file) => parseJsonl(readFileSync(path.join(this.eventDir, file), "utf8")));
  }

  private loadExistingCursors(): void {
    if (!existsSync(this.eventDir)) {
      return;
    }
    let maxCursor = 0;
    for (const file of readdirSync(this.eventDir)) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      for (const event of parseJsonl(readFileSync(path.join(this.eventDir, file), "utf8"))) {
        maxCursor = Math.max(maxCursor, event.cursor);
        this.latestByIdentifier.set(event.identifier, Math.max(this.latestByIdentifier.get(event.identifier) ?? 0, event.cursor));
      }
    }
    this.nextCursor = maxCursor + 1;
  }

  private loadQueuedSteering(): void {
    if (!existsSync(this.steeringPath)) {
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.steeringPath, "utf8")) as QueuedSteer[];
      for (const steer of parsed) {
        if (steer.issue && steer.text) {
          this.queuedSteering.set(steer.issue, steer);
        }
      }
    } catch {
      this.queuedSteering.clear();
    }
  }

  private persistQueuedSteering(): void {
    mkdirSync(this.stateDir, { recursive: true });
    writeFileSync(this.steeringPath, `${JSON.stringify([...this.queuedSteering.values()], null, 2)}\n`);
  }
}

export function workEventFromAgentEvent(context: AgentWorkContext, event: AgentRunEvent): Omit<AppendAgentWorkEventInput, keyof AgentWorkContext> {
  if (event.type === "process_started") {
    return {
      type: "process",
      summary: `codex app-server started${event.pid ? ` pid=${event.pid}` : ""}`,
      payload: { pid: event.pid }
    };
  }
  if (event.type === "stderr") {
    return {
      type: "stderr",
      level: "warn",
      summary: `codex app-server wrote ${event.bytes} stderr bytes`,
      payload: { bytes: event.bytes }
    };
  }
  if (event.type === "thread_started" || event.type === "thread_resumed") {
    return {
      type: "thread",
      summary: event.type === "thread_started" ? `thread started ${event.threadId}` : `thread resumed ${event.threadId}`,
      payload: { threadId: event.threadId }
    };
  }
  if (event.type === "turn_started") {
    return {
      type: "turn",
      summary: `turn started ${event.turnId ?? "-"}`,
      payload: { turnId: event.turnId }
    };
  }
  if (event.type === "rate_limited") {
    return {
      type: "rate_limited",
      level: "warn",
      summary: event.resumeAfterMs
        ? `codex rate limited until ${new Date(event.resumeAfterMs).toISOString()}`
        : "codex rate limited",
      payload: { resumeAfterMs: event.resumeAfterMs, reason: event.reason }
    };
  }

  return normalizeNotification(context, event.method, event.params);
}

function normalizeNotification(
  _context: AgentWorkContext,
  method: string,
  params: unknown
): Omit<AppendAgentWorkEventInput, keyof AgentWorkContext> {
  const rawPayload = params && typeof params === "object" ? params as JsonObject : null;
  const payload = rawPayload ? sanitizeNotificationPayload(rawPayload) : null;
  const item = payload && typeof payload.item === "object" && payload.item ? payload.item as JsonObject : null;
  const itemType = typeof item?.type === "string" ? item.type : "";
  const lowerMethod = method.toLowerCase();
  const lowerItemType = itemType.toLowerCase();

  if (method === "item/agentMessage/delta") {
    const delta = stringValue(payload?.delta) ?? stringValue(item?.text) ?? stringValue(item?.content) ?? "assistant message delta";
    return { type: "assistant_delta", summary: delta, payload };
  }
  if (method === "thread/goal/updated") {
    const goal = rawPayload && typeof rawPayload.goal === "object" && rawPayload.goal ? rawPayload.goal as JsonObject : null;
    const status = stringValue(goal?.status) ?? "unknown";
    const objective = stringValue(goal?.objective) ?? "goal updated";
    const tokensUsed = numberValue(goal?.tokensUsed);
    const timeUsedSeconds = numberValue(goal?.timeUsedSeconds);
    const usage = [
      tokensUsed === null ? null : `tokens=${tokensUsed}`,
      timeUsedSeconds === null ? null : `time=${timeUsedSeconds}s`
    ].filter(Boolean).join(" ");
    return {
      type: "goal",
      summary: `goal ${status}: ${objective}${usage ? ` (${usage})` : ""}`,
      payload
    };
  }
  if (method === "item/agentMessage/completed" || lowerItemType.includes("agent")) {
    const text = stringValue(item?.text) ?? stringValue(item?.content) ?? "assistant message";
    return { type: "assistant_message", summary: text, payload };
  }
  if (lowerItemType.includes("reason")) {
    const summary = stringValue(item?.summary) ?? "reasoning summary event";
    return { type: "reasoning_summary", summary, payload };
  }
  if (lowerItemType.includes("command") || lowerMethod.includes("command")) {
    const command = stringValue(item?.command) ?? stringValue(item?.text) ?? method;
    const status = stringValue(item?.status);
    return { type: "command", summary: status ? `${status}: ${command}` : command, payload };
  }
  if (lowerItemType.includes("tool") || lowerMethod.includes("tool")) {
    const name = stringValue(item?.name) ?? stringValue(item?.toolName) ?? method;
    return { type: "tool", summary: name, payload };
  }
  if (lowerItemType.includes("diff") || lowerMethod.includes("diff")) {
    return { type: "diff", summary: stringValue(item?.text) ?? method, payload };
  }
  if (lowerMethod.includes("error")) {
    return { type: "error", level: "error", summary: stringValue(payload?.message) ?? method, payload };
  }
  return { type: "notification", summary: method, payload };
}

function sanitizeNotificationPayload(payload: JsonObject): JsonObject {
  const sanitized = redactJson(payload);
  const item = sanitized.item;
  if (item && typeof item === "object" && "type" in item) {
    const itemObject = item as JsonObject;
    const type = typeof itemObject.type === "string" ? itemObject.type.toLowerCase() : "";
    if (type.includes("reason")) {
      delete itemObject.content;
      delete itemObject.text;
      delete itemObject.delta;
    }
  }
  return sanitized;
}

function redactJson(value: JsonObject): JsonObject {
  return redactUnknown(value) as JsonObject;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactUnknown);
  }
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, nested] of Object.entries(value)) {
      if (/api[_-]?key|token|secret|password|authorization|credential/i.test(key)) {
        output[key] = "[REDACTED]";
      } else {
        output[key] = redactUnknown(nested);
      }
    }
    return output;
  }
  return value;
}

function redact(value: string): string {
  return value
    .replace(/\b(?:sk|lin|ghp|github_pat|xox[baprs])[-_][-A-Za-z0-9_]{12,}\b/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_/-]{20,}\.[A-Za-z0-9_/-]{20,}\.[A-Za-z0-9_/-]{20,}\b/g, "[REDACTED]");
}

function parseJsonl(value: string): AgentWorkEvent[] {
  return value
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as AgentWorkEvent];
      } catch {
        return [];
      }
    });
}

function sanitizeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "issue";
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clampLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    return 100;
  }
  return Math.min(value, 1000);
}
