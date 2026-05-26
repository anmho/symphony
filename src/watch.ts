import {
  DEFAULT_LOG_VIEWPORT,
  applyLogViewportKey,
  buildLogLines,
  visibleLogWindow,
  type LogViewportKey,
  type LogViewportState,
} from './eventDisplay.js';
import type { AgentWorkEvent, OrchestratorSnapshot } from './types.js';
import {
  fetchDaemonEvents,
  fetchDaemonStatus,
  queueSteer,
  resumeIssue,
  setDaemonMaxConcurrency,
} from './status.js';
import { isRateLimitError } from './rateLimit.js';
import {
  computeWatchLayout,
  fillTerminalScreen,
  formatWatchTableHeader,
  formatWatchTableRow,
  measureWatchTableWidths,
  padLineToWidth,
  type WatchLayout,
  type WatchTableRow,
} from './watchLayout.js';

const LOG_FETCH_LIMIT = 1000;
const WATCH_CHROME_LINES = 5;

export interface WatchOptions {
  port: number;
  intervalMs: number;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
}

interface WatchRow {
  kind: 'running' | 'parked' | 'retry' | 'review' | 'completed';
  issue: string;
  issueKey: string;
  age: string;
  turn: string;
  event: string;
  updated: string;
  workspace: string;
  detail: string[];
}

type WatchView = 'agents' | 'describe' | 'events' | 'help';
type InputMode = 'normal' | 'command' | 'filter';

interface RenderOptions {
  nowMs: number;
  port: number;
  selectedIndex: number;
  view?: WatchView;
  inputMode?: InputMode;
  commandBuffer?: string;
  filterText?: string;
  events?: AgentWorkEvent[];
  logViewport?: LogViewportState;
  logViewportHeight?: number;
  terminalWidth?: number;
  terminalRows?: number;
  layout?: WatchLayout;
  logLines?: string[];
  fillScreen?: boolean;
  color?: boolean;
}

interface Theme {
  dim(value: string): string;
  title(value: string): string;
  accent(value: string): string;
  warn(value: string): string;
  error(value: string): string;
  ok(value: string): string;
  header(value: string): string;
  selected(value: string): string;
  status(kind: WatchRow['kind'], value: string): string;
}

export async function runStatusWatch(options: WatchOptions): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  if (input.isTTY && output.isTTY) {
    await runOpenTuiStatusWatch({ ...options, input, output });
    return;
  }

  const snapshot = await fetchDaemonStatus(options.port);
  output.write(
    renderStatusScreen(snapshot, {
      nowMs: Date.now(),
      port: options.port,
      selectedIndex: 0,
      color: false,
    }),
  );
  output.write('\n');
}

async function runOpenTuiStatusWatch(
  options: Required<
    Pick<WatchOptions, 'port' | 'intervalMs' | 'input' | 'output'>
  >,
): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const intervalMs = Math.max(options.intervalMs, 250);
  let selectedIndex = 0;
  let view: WatchView = 'agents';
  let inputMode: InputMode = 'normal';
  let commandBuffer = '';
  let filterText = '';
  let logViewport: LogViewportState = { ...DEFAULT_LOG_VIEWPORT };
  let logEvents: AgentWorkEvent[] = [];
  let logEventsIssue: string | null = null;
  let currentLogViewportHeight = 16;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const opentui = await import('@opentui/core');
  const { createCliRenderer, TextRenderable } = opentui;
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    clearOnShutdown: true,
    targetFps: 30,
    backgroundColor: '#11111b',
    screenMode: 'alternate-screen',
  });
  const screen = new TextRenderable(renderer, {
    id: 'symphony-watch',
    width: '100%',
    height: '100%',
    fg: '#cdd6f4',
    wrapMode: 'none',
    truncate: true,
    content: '',
  });
  renderer.root.add(screen);

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    if (timer) {
      clearInterval(timer);
    }
    renderer.destroy();
  };

  const render = async () => {
    const snapshot = await fetchDaemonStatus(options.port);
    const rowCount = snapshot
      ? filteredRows(snapshot, Date.now(), filterText).length
      : 0;
    selectedIndex = clamp(selectedIndex, 0, Math.max(rowCount - 1, 0));
    const selected = snapshot
      ? (filteredRows(snapshot, Date.now(), filterText)[selectedIndex] ?? null)
      : null;
    const terminalWidth = renderer.terminalWidth ?? output.columns ?? 120;
    const terminalRows = renderer.terminalHeight ?? output.rows ?? 40;
    const layout = computeWatchLayout({
      view,
      terminalWidth,
      terminalRows,
      chromeLineCount: WATCH_CHROME_LINES,
      rowCount,
      selectedIndex,
    });
    const logViewportHeight = layout.logViewportHeight;
    currentLogViewportHeight = logViewportHeight;

    if (selected && view === 'events') {
      if (logEventsIssue !== selected.issueKey) {
        logEventsIssue = selected.issueKey;
        logEvents = [];
        logViewport = { ...DEFAULT_LOG_VIEWPORT };
      }
      logEvents =
        (await fetchDaemonEvents(options.port, {
          issue: selected.issueKey,
          limit: LOG_FETCH_LIMIT,
          visible: true,
        })) ?? [];
    } else if (view !== 'events') {
      logEventsIssue = null;
    }

    const describeEvents =
      snapshot && selected && view === 'describe'
        ? await fetchDaemonEvents(options.port, {
            issue: selected.issueKey,
            limit: 40,
          })
        : [];
    const logSection =
      view === 'events' && selected
        ? renderLogSection(
            logEvents,
            logViewport,
            logViewportHeight,
            terminalWidth,
            createTheme(true),
          )
        : null;
    if (logSection) {
      logViewport = logSection.viewport;
    }

    const renderOptions: RenderOptions = {
      nowMs: Date.now(),
      port: options.port,
      selectedIndex,
      view,
      inputMode,
      commandBuffer,
      filterText,
      events: view === 'describe' ? (describeEvents ?? []) : logEvents,
      logViewport,
      logViewportHeight,
      terminalWidth,
      terminalRows,
      layout,
      fillScreen: true,
      color: true,
    };
    if (logSection) {
      renderOptions.logLines = logSection.lines;
    }
    screen.content = ansiToStyledText(
      renderStatusScreen(snapshot, renderOptions),
      opentui,
    ) as string;
  };

  renderer.on('resize', () => {
    if (!stopped) {
      void render();
    }
  });

  renderer.keyInput.on(
    'keypress',
    (key: {
      name: string;
      ctrl?: boolean;
      raw?: string;
      sequence?: string;
      preventDefault?: () => void;
    }) => {
      const chunk = key.raw ?? key.sequence ?? key.name;
      if (key.ctrl && key.name === 'c') {
        key.preventDefault?.();
        stop();
        return;
      }

      if (inputMode !== 'normal') {
        if (key.name === 'escape') {
          inputMode = 'normal';
          commandBuffer = '';
          void render();
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          if (inputMode === 'command') {
            const command = commandBuffer.trim().toLowerCase();
            commandBuffer = '';
            inputMode = 'normal';
            if (command === 'q' || command === 'quit') {
              stop();
              return;
            }
            if (
              command === 'agents' ||
              command === 'agent' ||
              command === 'ag'
            ) {
              view = 'agents';
            } else if (
              command === 'describe' ||
              command === 'desc' ||
              command === 'd'
            ) {
              view = 'describe';
            } else if (
              command === 'events' ||
              command === 'event' ||
              command === 'logs' ||
              command === 'l'
            ) {
              view = 'events';
            } else if (
              command === 'help' ||
              command === 'h' ||
              command === '?'
            ) {
              view = 'help';
            } else if (command === 'clear' || command === 'filter clear') {
              filterText = '';
            } else if (command === 'retry' || command === 'resume') {
              void selectedIssue(options.port, filterText, selectedIndex)
                .then((issue) =>
                  issue ? resumeIssue(options.port, issue) : null,
                )
                .then(() => render());
            } else if (
              command === 'concurrency clear' ||
              command === 'max-concurrency clear'
            ) {
              void setDaemonMaxConcurrency(options.port, null).then(() =>
                render(),
              );
            } else if (
              command.startsWith('concurrency ') ||
              command.startsWith('max-concurrency ')
            ) {
              const rawValue = command.split(/\s+/, 2)[1] ?? '';
              const value = Number(rawValue);
              if (Number.isInteger(value) && value > 0) {
                void setDaemonMaxConcurrency(options.port, value).then(() =>
                  render(),
                );
              }
            } else if (command.startsWith('steer ')) {
              const text = commandBuffer.trim().slice('steer '.length);
              void selectedIssue(options.port, filterText, selectedIndex)
                .then((issue) =>
                  issue ? queueSteer(options.port, issue, text) : null,
                )
                .then(() => render());
            }
          } else {
            filterText = commandBuffer;
            commandBuffer = '';
            inputMode = 'normal';
            selectedIndex = 0;
          }
          void render();
          return;
        }
        if (key.name === 'backspace') {
          commandBuffer = commandBuffer.slice(0, -1);
          void render();
          return;
        }
        if (chunk.length === 1 && chunk >= ' ') {
          commandBuffer += chunk;
          void render();
        }
        return;
      }

      if (key.name === 'q') {
        stop();
        return;
      }
      if (key.name === '?' || key.name === 'h') {
        view = view === 'help' ? 'agents' : 'help';
        void render();
        return;
      }
      if (key.name === ':') {
        inputMode = 'command';
        commandBuffer = '';
        void render();
        return;
      }
      if (key.name === '/') {
        inputMode = 'filter';
        commandBuffer = filterText;
        void render();
        return;
      }
      if (key.ctrl && key.name === 'r') {
        void render();
        return;
      }
      if (key.name === 'a') {
        view = 'agents';
        void render();
        return;
      }
      if (key.name === 'd') {
        view = 'describe';
        void render();
        return;
      }
      if (key.name === 'l' || key.name === 'e') {
        view = 'events';
        logViewport = { ...DEFAULT_LOG_VIEWPORT };
        void render();
        return;
      }
      if (key.name === 's') {
        inputMode = 'command';
        commandBuffer = 'steer ';
        void render();
        return;
      }
      if (key.name === 'r') {
        void selectedIssue(options.port, filterText, selectedIndex)
          .then((issue) => (issue ? resumeIssue(options.port, issue) : null))
          .then(() => render());
        return;
      }
      if (key.name === 'escape') {
        if (view !== 'agents') {
          view = 'agents';
          logViewport = { ...DEFAULT_LOG_VIEWPORT };
        } else {
          filterText = '';
        }
        void render();
        return;
      }

      if (view === 'events') {
        const terminalWidth = output.columns ?? 120;
        const lineCount = buildLogLines(
          logEvents,
          Math.max(terminalWidth - 4, 40),
          logViewport.wrap,
        ).length;
        const logKey = watchLogKey(key);
        if (logKey) {
          logViewport = applyLogViewportKey(
            logViewport,
            logKey,
            lineCount,
            currentLogViewportHeight,
          );
          void render();
          return;
        }
        if (key.name === 'w') {
          logViewport = { ...logViewport, wrap: !logViewport.wrap };
          void render();
          return;
        }
      }

      if (key.name === 'up' || key.name === 'k') {
        selectedIndex = Math.max(selectedIndex - 1, 0);
        void render();
        return;
      }
      if (key.name === 'down' || key.name === 'j') {
        selectedIndex += 1;
        void render();
      }
    },
  );

  await render();
  timer = setInterval(() => {
    if (!stopped) {
      void render();
    }
  }, intervalMs);
}

export function renderStatusScreen(
  snapshot: OrchestratorSnapshot | null,
  options: RenderOptions,
): string {
  const view = options.view ?? 'agents';
  const inputMode = options.inputMode ?? 'normal';
  const commandBuffer = options.commandBuffer ?? '';
  const filterText = options.filterText ?? '';
  const theme = createTheme(options.color ?? false);

  if (!snapshot) {
    return [
      `${theme.title('symphony')} ${theme.dim('watch')}  port=${options.port}`,
      '',
      theme.warn('Symphony is not running.'),
      '',
      `${theme.dim('Start it with:')} symphony start`,
    ].join('\n');
  }

  const rows = filteredRows(snapshot, options.nowMs, filterText);
  const selectedIndex = clamp(
    options.selectedIndex,
    0,
    Math.max(rows.length - 1, 0),
  );
  const selected = rows[selectedIndex] ?? null;
  const rateLimit = snapshot.codexRateLimit.resumeAfterMs
    ? theme.warn(
        `${formatTime(snapshot.codexRateLimit.resumeAfterMs)} ${snapshot.codexRateLimit.reason ?? ''}`.trim(),
      )
    : theme.ok('-');
  const dispatchPause = snapshot.paused ? theme.warn('paused') : theme.ok('-');
  const configError = snapshot.lastConfigError
    ? theme.error(snapshot.lastConfigError)
    : theme.ok('-');
  const terminalWidth = options.terminalWidth ?? 120;
  const terminalRows = options.terminalRows ?? 40;
  const layout =
    options.layout ??
    computeWatchLayout({
      view,
      terminalWidth,
      terminalRows,
      chromeLineCount: WATCH_CHROME_LINES,
      rowCount: rows.length,
      selectedIndex,
    });

  const headerLine = padLineToWidth(
    `${theme.title('symphony@local')}  ${theme.dim('view=')}${theme.accent(view)}  ${theme.dim('port=')}${options.port}  ${theme.dim('uptime=')}${formatDuration(options.nowMs - snapshot.startedAtMs)}  ${theme.dim('running=')}${theme.ok(`${snapshot.concurrency.running}/${snapshot.concurrency.effectiveMax ?? '?'}`)}  ${theme.dim('max-source=')}${snapshot.concurrency.overrideActive ? theme.warn('override') : theme.ok(snapshot.concurrency.source)}  ${theme.dim('retries=')}${snapshot.retryAttempts.length > 0 ? theme.warn(String(snapshot.retryAttempts.length)) : '0'}  ${theme.dim('handoff=')}${snapshot.handoff.length}  ${theme.dim('completed=')}${snapshot.completed.length}`,
    terminalWidth,
  );
  const workflowLine = padLineToWidth(
    `${theme.dim('workflow=')}${truncate(snapshot.workflowPath, Math.max(terminalWidth - 11, 20))}`,
    terminalWidth,
  );
  const metaLine = padLineToWidth(
    `${theme.dim('filter=')}${filterText || '-'}  ${theme.dim('rate-limit=')}${rateLimit}  ${theme.dim('dispatch=')}${dispatchPause}  ${theme.dim('config-error=')}${configError}`,
    terminalWidth,
  );
  const menuLine = padLineToWidth(
    renderMenu(inputMode, commandBuffer, theme),
    terminalWidth,
  );

  const content = [
    headerLine,
    workflowLine,
    metaLine,
    '',
    menuLine,
    '',
    renderView(view, rows, selectedIndex, selected, theme, {
      ...options,
      layout,
      terminalWidth,
    }),
  ].join('\n');

  if (!options.fillScreen) {
    return content;
  }
  return fillTerminalScreen(content, terminalWidth, terminalRows);
}

export function renderLogSection(
  events: AgentWorkEvent[],
  viewport: LogViewportState,
  viewportHeight: number,
  terminalWidth: number,
  theme: Theme,
): { lines: string[]; viewport: LogViewportState } {
  const wrapWidth = Math.max(terminalWidth - 4, 40);
  const lines = buildLogLines(events, wrapWidth, viewport.wrap);
  const sourceLines =
    lines.length > 0
      ? lines
      : emptyLogFallbackLines(events, terminalWidth, theme);
  const window = visibleLogWindow(sourceLines, viewport, viewportHeight);
  const rendered = window.lines.map((line, index) => {
    const absoluteLine = window.scrollTop + index;
    const marker = absoluteLine === window.selectedLine ? '>' : ' ';
    return colorLogLine(
      padLineToWidth(`${marker} ${line}`, terminalWidth),
      theme,
    );
  });
  return {
    lines: rendered,
    viewport: {
      ...viewport,
      scrollTop: window.scrollTop,
      selectedLine: window.selectedLine,
    },
  };
}

function emptyLogFallbackLines(
  events: AgentWorkEvent[],
  terminalWidth: number,
  theme: Theme,
): string[] {
  if (events.length === 0) {
    return [theme.dim('No log events loaded yet.')];
  }
  const latest = events.at(-1);
  if (!latest) {
    return [theme.dim('No log events loaded yet.')];
  }
  const summary = truncateForTerminal(latest.summary, terminalWidth - 36);
  return [
    theme.dim(
      `No visible log lines in last ${events.length} raw events; latest ${latest.type}: ${summary}`,
    ),
  ];
}

function truncateForTerminal(value: string, width: number): string {
  if (width <= 1) {
    return '';
  }
  if (value.length <= width) {
    return value;
  }
  return `${value.slice(0, Math.max(width - 3, 0))}...`;
}

export function watchLogKey(key: {
  name: string;
  shift?: boolean;
}): LogViewportKey | null {
  if (key.name === 'up' || key.name === 'k') {
    return 'up';
  }
  if (key.name === 'down' || key.name === 'j') {
    return 'down';
  }
  if (key.name === 'pageup') {
    return 'pageup';
  }
  if (key.name === 'pagedown') {
    return 'pagedown';
  }
  if (key.name === 'g' && !key.shift) {
    return 'top';
  }
  if (
    key.name === 'G' ||
    (key.name === 'g' && key.shift) ||
    key.name === 'end'
  ) {
    return 'bottom';
  }
  if (key.name === 'home') {
    return 'top';
  }
  if (key.name === 'f') {
    return 'toggle-follow';
  }
  return null;
}

function filteredRows(
  snapshot: OrchestratorSnapshot,
  nowMs: number,
  filterText: string,
): WatchRow[] {
  const rows = watchRows(snapshot, nowMs);
  const filter = filterText.trim().toLowerCase();
  if (!filter) {
    return rows;
  }
  return rows.filter((row) =>
    [row.issue, row.kind, row.event, row.workspace, ...row.detail].some(
      (value) => value.toLowerCase().includes(filter),
    ),
  );
}

async function selectedIssue(
  port: number,
  filterText: string,
  selectedIndex: number,
): Promise<string | null> {
  const snapshot = await fetchDaemonStatus(port);
  if (!snapshot) {
    return null;
  }
  return (
    filteredRows(snapshot, Date.now(), filterText)[selectedIndex]?.issueKey ??
      null
  );
}

function watchRows(snapshot: OrchestratorSnapshot, nowMs: number): WatchRow[] {
  const running = snapshot.running.map(
    (session): WatchRow => ({
      kind: 'running',
      issue: session.title
        ? `${session.identifier} · ${session.title}`
        : session.identifier,
      issueKey: session.identifier,
      age: formatDuration(nowMs - session.startedAtMs),
      turn: String(session.turnCount),
      event: session.currentWorkKind ?? session.lastCodexEvent ?? '-',
      updated: (session.currentWorkUpdatedAtMs ?? session.lastCodexTimestamp)
        ? formatDuration(nowMs - (session.currentWorkUpdatedAtMs ?? session.lastCodexTimestamp ?? nowMs))
        : '-',
      workspace: shortenPath(session.workspacePath ?? '-'),
      detail: [
        `Issue: ${session.identifier}`,
        `State: running`,
        `Workspace: ${session.workspacePath ?? '-'}`,
        `Log: ${session.eventLogPath ?? '-'}`,
        `Thread: ${session.threadId ?? '-'}`,
        `Turn: ${session.turnId ?? '-'}`,
        `Goal: ${session.goalStatus ?? '-'}`,
        `Goal updated: ${session.goalUpdatedAtMs ? `${formatDuration(nowMs - session.goalUpdatedAtMs)} ago` : '-'}`,
        `Goal objective: ${session.goalObjective ?? '-'}`,
        `Codex PID: ${session.codexAppServerPid ?? '-'}`,
        `Current work: ${session.currentWork ?? '-'}`,
        `Current work updated: ${session.currentWorkUpdatedAtMs ? `${formatDuration(nowMs - session.currentWorkUpdatedAtMs)} ago` : '-'}`,
        `Latest event cursor: ${session.latestEventCursor ?? '-'}`,
        `Queued steering: ${session.queuedSteerCount}`,
        `Last event: ${session.lastCodexEvent ?? '-'}`,
        `Last update: ${session.lastCodexTimestamp ? `${formatDuration(nowMs - session.lastCodexTimestamp)} ago` : '-'}`,
        `Message: ${summarizeCodexMessage(session.lastCodexMessage)}`,
      ],
    }),
  );

  const retries = snapshot.retryAttempts.map(
    (attempt): WatchRow => {
      const parked = isRateLimitError(attempt.error);
      return {
        kind: parked ? 'parked' : 'retry',
        issue: attempt.title
          ? `${attempt.identifier} · ${attempt.title}`
          : attempt.identifier,
        issueKey: attempt.identifier,
        age: `in ${formatDuration(attempt.dueAtMs - nowMs)}`,
        turn: String(attempt.attempt),
        event: 'retry',
        updated: '-',
        workspace: '-',
        detail: [
          `Issue: ${attempt.identifier}`,
          `State: ${parked ? 'parked' : 'retry'}`,
          `Attempt: ${attempt.attempt}`,
          `Due: ${formatTime(attempt.dueAtMs)}`,
          `Error: ${attempt.error ?? '-'}`,
        ],
      };
    },
  );

  const completed = snapshot.completed.map(
    (issueId): WatchRow => {
      const detail = snapshot.completedDetails.find((issue) => issue.identifier === issueId);
      return {
      kind: 'completed',
      issue: detail?.title ? `${issueId} · ${detail.title}` : issueId,
      issueKey: issueId,
      age: '-',
      turn: '-',
      event: 'completed',
      updated: '-',
      workspace: '-',
      detail: [
        `Issue id: ${issueId}`,
        `State: ${detail?.state ?? 'completed'}`,
        `Review type: ${detail?.reviewKind ?? 'completed'}`,
        `PR: ${detail?.prUrl ?? '-'}`,
        `Repo: ${detail?.repoKey ?? '-'}`,
      ],
      };
    },
  );

  const handoff = snapshot.handoff.map(
    (issueId): WatchRow => {
      const detail = snapshot.handoffDetails.find((issue) => issue.identifier === issueId);
      return {
      kind: 'review',
      issue: detail?.title ? `${issueId} · ${detail.title}` : issueId,
      issueKey: issueId,
      age: '-',
      turn: '-',
      event: detail?.reviewKind === 'blocked' ? 'blocked' : 'pr-review',
      updated: '-',
      workspace: '-',
      detail: [
        `Issue id: ${issueId}`,
        `State: ${detail?.state ?? 'ready for human review'}`,
        `Review type: ${detail?.reviewKind ?? 'pr_review'}`,
        `PR: ${detail?.prUrl ?? '-'}`,
        `Repo: ${detail?.repoKey ?? '-'}`,
      ],
      };
    },
  );

  return [...running, ...retries, ...handoff, ...completed];
}

function renderTable(
  rows: WatchRow[],
  selectedIndex: number,
  theme: Theme,
  terminalWidth: number,
  layout: WatchLayout | null,
): string {
  const tableRows = rows.map(toWatchTableRow);
  const widths = measureWatchTableWidths(tableRows, terminalWidth);
  const header = theme.header(formatWatchTableHeader(widths));
  const window = layout?.tableWindow ?? { start: 0, end: rows.length };
  const body = rows.slice(window.start, window.end).map((row, index) => {
    const absoluteIndex = window.start + index;
    const marker = absoluteIndex === selectedIndex ? '>' : ' ';
    const line = formatWatchTableRow(toWatchTableRow(row), widths, marker);
    if (absoluteIndex === selectedIndex) {
      return theme.selected(padLineToWidth(line, terminalWidth));
    }
    return theme.status(row.kind, padLineToWidth(line, terminalWidth));
  });
  return [padLineToWidth(header, terminalWidth), ...body].join('\n');
}

function toWatchTableRow(row: WatchRow): WatchTableRow {
  return {
    issue: row.issue,
    kind: row.kind,
    age: row.age,
    turn: row.turn,
    event: row.event,
    updated: row.updated,
    workspace: row.workspace,
  };
}

function renderView(
  view: WatchView,
  rows: WatchRow[],
  selectedIndex: number,
  selected: WatchRow | null,
  theme: Theme,
  options: RenderOptions,
): string {
  const events = options.events ?? [];
  const terminalWidth = options.terminalWidth ?? 120;
  const layout = options.layout ?? null;
  if (view === 'help') {
    return [
      theme.header('HELP'),
      `  ${theme.accent(':agents')}        show agent resource table`,
      `  ${theme.accent(':describe')}      show selected agent details`,
      `  ${theme.accent(':events')}        show selected agent event/message`,
      `  ${theme.accent(':retry')}         retry/resume selected queued agent now`,
      `  ${theme.accent(':steer text')}    queue guidance for selected agent`,
      `  ${theme.accent(':concurrency N')} set max concurrent agents`,
      `  ${theme.accent(':concurrency clear')} use WORKFLOW.md concurrency`,
      `  ${theme.accent(':clear')}         clear filter`,
      `  ${theme.accent('/text')}          filter rows`,
      `  ${theme.accent('Up/Down j/k')}    move selection`,
      `  ${theme.accent('d')}              describe selected agent`,
      `  ${theme.accent('l')}              open logs for selected agent`,
      `  ${theme.accent('j/k Up/Down')}    scroll logs (in logs view)`,
      `  ${theme.accent('PgUp/PgDn')}      page logs (in logs view)`,
      `  ${theme.accent('g/G')}            jump to top/bottom of logs`,
      `  ${theme.accent('f')}              toggle log follow mode`,
      `  ${theme.accent('w')}              toggle log wrap`,
      `  ${theme.accent('s')}              open steer command for selected agent`,
      `  ${theme.accent('r')}              retry/resume selected queued agent now`,
      `  ${theme.accent('a or esc')}       return to agents table`,
      `  ${theme.accent('ctrl-r')}         refresh now`,
      `  ${theme.accent('q or :quit')}     quit`,
    ].join('\n');
  }

  if (view === 'describe') {
    return [
      renderTable(rows, selectedIndex, theme, terminalWidth, layout),
      '',
      theme.header(padLineToWidth('DESCRIBE', terminalWidth)),
      selected
        ? colorDetail(selected.detail, theme)
        : theme.warn('No selected agent.'),
    ].join('\n');
  }

  if (view === 'events') {
    const viewport = options.logViewport ?? DEFAULT_LOG_VIEWPORT;
    const followLabel = viewport.follow
      ? theme.ok('follow')
      : theme.dim('paused');
    const wrapLabel = viewport.wrap ? theme.ok('wrap') : theme.dim('nowrap');
    const logBody = options.logLines
      ? options.logLines.join('\n')
      : selected
        ? renderEvents(selected, events, theme, terminalWidth)
        : theme.warn('No selected agent.');
    return [
      renderTable(rows, selectedIndex, theme, terminalWidth, layout),
      '',
      padLineToWidth(
        `${theme.header('LOGS')}  ${theme.dim('follow=')}${followLabel}  ${theme.dim('wrap=')}${wrapLabel}  ${theme.dim('esc')} agents`,
        terminalWidth,
      ),
      logBody,
    ].join('\n');
  }

  return renderTable(rows, selectedIndex, theme, terminalWidth, layout);
}

function renderMenu(
  inputMode: InputMode,
  commandBuffer: string,
  theme: Theme,
): string {
  if (inputMode === 'command') {
    return `${theme.accent(':')}${commandBuffer}`;
  }
  if (inputMode === 'filter') {
    return `${theme.accent('/')}${commandBuffer}`;
  }
  return [
    menuKey('a', 'Agents', theme),
    menuKey('d', 'Describe', theme),
    menuKey('l', 'Logs', theme),
    menuKey('s', 'Steer', theme),
    menuKey('r', 'Retry', theme),
    menuKey('/', 'Filter', theme),
    menuKey(':', 'Command', theme),
    menuKey('?', 'Help', theme),
    menuKey('ctrl-r', 'Refresh', theme),
    menuKey('q', 'Quit', theme),
  ].join('  ');
}

function renderEvents(
  selected: WatchRow,
  events: AgentWorkEvent[],
  theme: Theme,
  terminalWidth: number,
): string {
  if (events.length === 0) {
    return colorDetail([selected.detail.at(-1) ?? 'No events loaded.'], theme);
  }
  const lines = buildLogLines(events, Math.max(terminalWidth - 4, 40), false);
  return lines
    .map((line) =>
      colorLogLine(padLineToWidth(`  ${line}`, terminalWidth), theme),
    )
    .join('\n');
}

function colorLogLine(line: string, theme: Theme): string {
  if (/\berror\b/.test(line)) {
    return theme.error(line);
  }
  if (/\bwarn\b/.test(line) || /\brate-limit\b/.test(line)) {
    return theme.warn(line);
  }
  if (/\bassistant\b/.test(line)) {
    return theme.ok(line);
  }
  return line;
}

function menuKey(key: string, label: string, theme: Theme): string {
  return `${theme.accent(`<${key}>`)} ${label}`;
}

function colorDetail(lines: string[], theme: Theme): string {
  return lines
    .map((line) => {
      const index = line.indexOf(':');
      if (index < 0) {
        return line;
      }
      return `${theme.dim(line.slice(0, index + 1))}${line.slice(index + 1)}`;
    })
    .join('\n');
}

function summarizeCodexMessage(value: string | null): string {
  if (!value) {
    return '-';
  }

  try {
    const parsed = JSON.parse(value) as {
      method?: string;
      params?: {
        item?: {
          type?: string;
          text?: string;
          command?: string;
          status?: string;
        };
        turnId?: string;
        delta?: string;
      };
    };
    const item = parsed.params?.item;
    if (item?.command) {
      return truncate(
        `${item.type ?? 'command'} ${item.status ?? ''}: ${item.command}`.trim(),
        180,
      );
    }
    if (item?.text) {
      return truncate(item.text, 180);
    }
    if (parsed.params?.delta) {
      return truncate(`delta: ${parsed.params.delta}`, 180);
    }
    return truncate(parsed.method ?? value, 180);
  } catch {
    return truncate(value, 180);
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m${seconds}s`;
  }
  return `${seconds}s`;
}

function formatTime(ms: number): string {
  return new Date(ms).toISOString();
}

function shortenPath(value: string): string {
  const home = process.env.HOME;
  return home && value.startsWith(`${home}/`)
    ? `~/${value.slice(home.length + 1)}`
    : value;
}

function truncate(value: string, length: number): string {
  if (value.length <= length) {
    return value;
  }
  return `${value.slice(0, Math.max(length - 3, 0))}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function createTheme(enabled: boolean): Theme {
  const paint = (code: string, value: string) =>
    enabled ? `\x1b[${code}m${value}\x1b[0m` : value;
  return {
    dim: (value) => paint('2', value),
    title: (value) => paint('1;36', value),
    accent: (value) => paint('33', value),
    warn: (value) => paint('33', value),
    error: (value) => paint('31', value),
    ok: (value) => paint('32', value),
    header: (value) => paint('1;37', value),
    selected: (value) => paint('7', value),
    status: (kind, value) => {
      if (kind === 'retry' || kind === 'parked') {
        return paint('33', value);
      }
      if (kind === 'review') {
        return paint('35', value);
      }
      if (kind === 'completed') {
        return paint('32', value);
      }
      return paint('36', value);
    },
  };
}

function ansiToStyledText(
  value: string,
  opentui: Record<string, unknown>,
): unknown {
  const StyledText = opentui.StyledText as new (chunks: unknown[]) => unknown;
  const fg = opentui.fg as (color: string) => (input: string) => unknown;
  const bold = opentui.bold as (input: unknown) => unknown;
  const dim = opentui.dim as (input: unknown) => unknown;
  const reverse = opentui.reverse as (input: unknown) => unknown;
  const chunks: unknown[] = [];
  const regex = /\x1b\[([0-9;]+)m/g;
  let index = 0;
  let style = ansiStyle();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(value)) !== null) {
    if (match.index > index) {
      chunks.push(
        applyAnsiStyle(value.slice(index, match.index), style, {
          fg,
          bold,
          dim,
          reverse,
        }),
      );
    }
    style = updateAnsiStyle(style, match[1] ?? '');
    index = regex.lastIndex;
  }

  if (index < value.length) {
    chunks.push(
      applyAnsiStyle(value.slice(index), style, { fg, bold, dim, reverse }),
    );
  }

  return new StyledText(chunks);
}

function ansiStyle(): {
  color: string | null;
  bold: boolean;
  dim: boolean;
  reverse: boolean;
} {
  return {
    color: null,
    bold: false,
    dim: false,
    reverse: false,
  };
}

function updateAnsiStyle(
  current: ReturnType<typeof ansiStyle>,
  codesValue: string,
): ReturnType<typeof ansiStyle> {
  const next = { ...current };
  const codes = codesValue.split(';').map((code) => Number(code));
  for (const code of codes) {
    if (code === 0) {
      return ansiStyle();
    }
    if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 7) {
      next.reverse = true;
    } else if (code === 31) {
      next.color = 'brightRed';
    } else if (code === 32) {
      next.color = 'brightGreen';
    } else if (code === 33) {
      next.color = 'brightYellow';
    } else if (code === 36) {
      next.color = 'brightCyan';
    } else if (code === 37) {
      next.color = 'brightWhite';
    }
  }
  return next;
}

function applyAnsiStyle(
  text: string,
  style: ReturnType<typeof ansiStyle>,
  helpers: {
    fg: (color: string) => (input: string) => unknown;
    bold: (input: unknown) => unknown;
    dim: (input: unknown) => unknown;
    reverse: (input: unknown) => unknown;
  },
): unknown {
  let chunk: unknown = helpers.fg(style.color ?? '#cdd6f4')(text);
  if (style.bold) {
    chunk = helpers.bold(chunk);
  }
  if (style.dim) {
    chunk = helpers.dim(chunk);
  }
  if (style.reverse) {
    chunk = helpers.reverse(chunk);
  }
  return chunk;
}
