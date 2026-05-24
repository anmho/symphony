export interface WatchTableRow {
  issue: string;
  kind: string;
  age: string;
  turn: string;
  event: string;
  updated: string;
  workspace: string;
}

export interface WatchTableWidths {
  marker: number;
  issue: number;
  status: number;
  age: number;
  turn: number;
  event: number;
  updated: number;
  workspace: number;
}

export interface WatchLayout {
  terminalWidth: number;
  terminalRows: number;
  contentWidth: number;
  tableMaxRows: number | null;
  logViewportHeight: number;
  tableWindow: { start: number; end: number } | null;
}

export type WatchLayoutView = "agents" | "describe" | "events" | "help";

const MIN_LOG_HEIGHT = 8;
const MIN_TABLE_ROWS = 3;

export function measureWatchTableWidths(rows: WatchTableRow[], terminalWidth: number): WatchTableWidths {
  const marker = 2;
  const issue = Math.max(5, "ISSUE".length, ...rows.map((row) => row.issue.length)) + 1;
  const status = Math.max(6, "STATUS".length, ...rows.map((row) => row.kind.length)) + 1;
  const age = Math.max(3, "AGE".length, ...rows.map((row) => row.age.length)) + 1;
  const turn = Math.max(4, "TURN".length, ...rows.map((row) => row.turn.length)) + 1;
  const event = Math.max(5, "EVENT".length, ...rows.map((row) => row.event.length)) + 1;
  const updated = Math.max(7, "UPDATED".length, ...rows.map((row) => row.updated.length)) + 1;

  const separators = 7;
  const fixed =
    marker + issue + status + age + turn + event + updated + separators;
  const workspace = Math.max(9, terminalWidth - fixed);

  return { marker, issue, status, age, turn, event, updated, workspace };
}

export function formatWatchTableRow(
  row: WatchTableRow,
  widths: WatchTableWidths,
  marker: string
): string {
  return [
    padCell(marker, widths.marker),
    padCell(row.issue, widths.issue),
    padCell(row.kind, widths.status),
    padCell(row.age, widths.age),
    padCell(row.turn, widths.turn),
    padCell(row.event, widths.event),
    padCell(row.updated, widths.updated),
    padCell(row.workspace, widths.workspace)
  ].join(" ");
}

export function formatWatchTableHeader(widths: WatchTableWidths): string {
  return formatWatchTableRow(
    {
      issue: "ISSUE",
      kind: "STATUS",
      age: "AGE",
      turn: "TURN",
      event: "EVENT",
      updated: "UPDATED",
      workspace: "WORKSPACE"
    },
    widths,
    " "
  );
}

export function visibleTableWindow(
  rowCount: number,
  selectedIndex: number,
  maxRows: number
): { start: number; end: number } {
  if (rowCount <= maxRows) {
    return { start: 0, end: rowCount };
  }

  let start = Math.max(0, selectedIndex - Math.floor(maxRows / 2));
  let end = Math.min(rowCount, start + maxRows);
  start = Math.max(0, end - maxRows);
  return { start, end };
}

export function computeWatchLayout(input: {
  view: WatchLayoutView;
  terminalWidth: number;
  terminalRows: number;
  chromeLineCount: number;
  rowCount: number;
  selectedIndex: number;
}): WatchLayout {
  const terminalWidth = Math.max(input.terminalWidth, 40);
  const terminalRows = Math.max(input.terminalRows, 12);
  const contentWidth = terminalWidth;

  if (input.view === "help") {
    return {
      terminalWidth,
      terminalRows,
      contentWidth,
      tableMaxRows: null,
      logViewportHeight: 0,
      tableWindow: null
    };
  }

  if (input.view === "agents") {
    const tableHeaderLines = 1;
    const maxTableRows = Math.max(1, terminalRows - input.chromeLineCount - tableHeaderLines);
    return {
      terminalWidth,
      terminalRows,
      contentWidth,
      tableMaxRows: maxTableRows,
      logViewportHeight: 0,
      tableWindow: visibleTableWindow(input.rowCount, input.selectedIndex, maxTableRows)
    };
  }

  const tableHeaderLines = 1;
  const sectionHeaderLines = input.view === "events" ? 2 : 2;
  const reserved =
    input.chromeLineCount + tableHeaderLines + sectionHeaderLines + MIN_LOG_HEIGHT;
  const availableForTable = Math.max(
    MIN_TABLE_ROWS,
    terminalRows - reserved
  );
  const tableMaxRows = Math.min(
    input.rowCount,
    Math.max(MIN_TABLE_ROWS, Math.floor(availableForTable * 0.4))
  );
  const tableLines = tableHeaderLines + tableMaxRows;
  const logViewportHeight = Math.max(
    MIN_LOG_HEIGHT,
    terminalRows - input.chromeLineCount - tableLines - sectionHeaderLines
  );
  const tableWindow = visibleTableWindow(input.rowCount, input.selectedIndex, tableMaxRows);

  return {
    terminalWidth,
    terminalRows,
    contentWidth,
    tableMaxRows,
    logViewportHeight,
    tableWindow
  };
}

export function padLineToWidth(line: string, width: number): string {
  const visible = visibleTextWidth(line);
  if (visible >= width) {
    return line;
  }
  return `${line}${" ".repeat(width - visible)}`;
}

export function fillTerminalScreen(content: string, terminalWidth: number, terminalRows: number): string {
  const width = Math.max(terminalWidth, 1);
  const height = Math.max(terminalRows, 1);
  const lines = content.split("\n").map((line) => padLineToWidth(line, width));
  while (lines.length < height) {
    lines.push(" ".repeat(width));
  }
  return lines.slice(0, height).join("\n");
}

export function visibleTextWidth(value: string): number {
  let plain = "";
  let index = 0;
  while (index < value.length) {
    if (value[index] === "\u001b" && value[index + 1] === "[") {
      const end = value.indexOf("m", index);
      if (end >= 0) {
        index = end + 1;
        continue;
      }
    }
    plain += value[index]!;
    index += 1;
  }
  return plain.length;
}

function padCell(value: string, width: number): string {
  const truncated = truncateVisible(value, width);
  return truncated.padEnd(width, " ");
}

function truncateVisible(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }
  if (visibleTextWidth(value) <= width) {
    return value;
  }
  if (width <= 3) {
    return value.slice(0, width);
  }
  let remaining = width - 3;
  let output = "";
  for (const char of value) {
    if (remaining <= 0) {
      break;
    }
    output += char;
    remaining -= 1;
  }
  return `${output}...`;
}
