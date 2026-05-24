import { describe, expect, it } from "vitest";
import {
  computeWatchLayout,
  fillTerminalScreen,
  formatWatchTableRow,
  measureWatchTableWidths,
  padLineToWidth,
  visibleTextWidth
} from "../src/watchLayout.js";

describe("watchLayout", () => {
  it("allocates remaining width to workspace column", () => {
    const widths = measureWatchTableWidths(
      [
        {
          issue: "ANM-277",
          kind: "retry",
          age: "in 7m",
          turn: "6",
          event: "error",
          updated: "-",
          workspace: "~/repos/projects/symphony"
        }
      ],
      120
    );

    const line = formatWatchTableRow(
      {
        issue: "ANM-277",
        kind: "retry",
        age: "in 7m",
        turn: "6",
        event: "error",
        updated: "-",
        workspace: "~/repos/projects/symphony"
      },
      widths,
      ">"
    );

    expect(visibleTextWidth(line)).toBe(120);
    expect(widths.workspace).toBeGreaterThan(30);
  });

  it("uses remaining terminal height for logs in events view", () => {
    const layout = computeWatchLayout({
      view: "events",
      terminalWidth: 120,
      terminalRows: 40,
      chromeLineCount: 5,
      rowCount: 12,
      selectedIndex: 3
    });

    expect(layout.logViewportHeight).toBeGreaterThan(16);
    expect(layout.tableWindow).not.toBeNull();
    expect(layout.tableWindow!.end - layout.tableWindow!.start).toBeLessThanOrEqual(12);
  });

  it("fills unused terminal rows with blank space", () => {
    const filled = fillTerminalScreen("line one\nline two", 20, 5);
    expect(filled.split("\n")).toHaveLength(5);
    expect(padLineToWidth("x", 10)).toHaveLength(10);
  });
});
