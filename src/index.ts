#!/usr/bin/env node
import { Command } from "commander";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { loadWorkflowConfig, renderConfigSummary, resolveWorkflowPath } from "./config.js";
import { logger } from "./logger.js";
import { createDefaultOrchestrator } from "./orchestrator.js";
import { runCommand } from "./process.js";
import {
  DEFAULT_STATUS_PORT,
  fetchDaemonEvents,
  fetchDaemonStatus,
  queueSteer,
  resumeIssue,
  resumeRateLimitedRuns,
  startStatusServer
} from "./status.js";
import { StreamingEventDisplay, formatDisplayEvent } from "./eventDisplay.js";
import { runStatusWatch } from "./watch.js";

interface CliOptions {
  workflow?: string;
  statusPort: string;
}

const program = new Command();

program
  .name("symphony")
  .description("TypeScript Symphony v1: Linear-driven local runner for Codex app-server agents.")
  .option("-w, --workflow <path>", "path to WORKFLOW.md")
  .option("--status-port <port>", "local status server port", String(DEFAULT_STATUS_PORT));

program.command("install").description("Build and globally link the symphony command with Bun.").action(async () => {
  const root = packageRoot();
  await checkedRun("bun", ["install"], root);
  await checkedRun("bun", ["run", "build"], root);
  await checkedRun("bun", ["link"], root);
  console.log("Installed symphony globally with bun link.");
});

program.command("start").description("Start Symphony as a normal background user process.").action(async () => {
  await startBackground(program.opts<CliOptions>());
});

program.command("run").description("Run Symphony in the foreground.").action(async () => {
  await runForeground(program.opts<CliOptions>());
});

program.command("stop").description("Stop the background Symphony process.").action(async () => {
  await stopBackground(program.opts<CliOptions>());
});

program.command("validate-config").description("Load and validate WORKFLOW.md.").action(async () => {
  const workflowPath = await resolveWorkflowPath(program.opts<CliOptions>().workflow);
  const config = await loadWorkflowConfig(workflowPath);
  console.log(renderConfigSummary(config));
});

program.command("status").description("Read the local runner status endpoint.").action(async () => {
  const port = readStatusPort(program.opts<CliOptions>());
  const status = await fetchDaemonStatus(port);
  if (!status) {
    const pid = readPid(port);
    const suffix = pid ? ` Stale pid file exists for pid ${pid}.` : "";
    console.log(`Symphony is not running on 127.0.0.1:${port}.${suffix}`);
    return;
  }
  console.log(JSON.stringify(status, null, 2));
});

program.command("logs")
  .description("Show the public work stream for an agent.")
  .argument("[issue]", "issue identifier or id, for example ANM-123")
  .option("-a, --all", "show all issue streams")
  .option("-f, --follow", "follow new events")
  .option("--json", "print JSON events")
  .option("--limit <count>", "events to read per poll", "100")
  .option("-i, --interval <ms>", "follow poll interval in milliseconds", "1000")
  .action(async (issue: string | undefined, options: { all?: boolean; follow?: boolean; json?: boolean; limit: string; interval: string }) => {
    await runLogsCommand(issue ?? null, options, program.opts<CliOptions>());
  });

program.command("steer")
  .description("Queue operator guidance for the next Codex turn on an issue.")
  .argument("<issue>", "issue identifier or id, for example ANM-123")
  .argument("<instruction...>", "guidance text")
  .action(async (issue: string, instruction: string[]) => {
    const port = readStatusPort(program.opts<CliOptions>());
    const result = await queueSteer(port, issue, instruction.join(" "));
    if (!result) {
      console.log(`Symphony is not running on 127.0.0.1:${port}, or this runner does not support steering.`);
      return;
    }
    console.log(`Queued steering for ${result.issue}.`);
  });

program.command("watch")
  .description("Open a k9s-style terminal monitor for Symphony agents.")
  .option("-i, --interval <ms>", "refresh interval in milliseconds", "2000")
  .action(async (options: { interval: string }) => {
    if (reexecInteractiveWatchWithBun()) {
      return;
    }
    await runStatusWatch({
      port: readStatusPort(program.opts<CliOptions>()),
      intervalMs: readIntervalMs(options.interval)
    });
  });

program.command("resume")
  .description("Clear the in-memory Codex rate-limit gate and retry parked runs now.")
  .action(async () => {
    const port = readStatusPort(program.opts<CliOptions>());
    const result = await resumeRateLimitedRuns(port);
    if (!result) {
      console.log(`Symphony is not running on 127.0.0.1:${port}, or this runner does not support resume.`);
      return;
    }
    console.log(`Resumed ${result.resumed} rate-limited run${result.resumed === 1 ? "" : "s"}.`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  logger.error({ error }, "symphony command failed");
  process.exitCode = 1;
});

async function startBackground(options: CliOptions): Promise<void> {
  const workflowPath = await resolveWorkflowPath(options.workflow);
  const statusPort = readStatusPort(options);

  if (await fetchDaemonStatus(statusPort)) {
    console.log(`Symphony is already running on 127.0.0.1:${statusPort}.`);
    return;
  }

  await loadWorkflowConfig(workflowPath);
  mkdirSync(stateDir(), { recursive: true });

  const logFd = openSync(logPath(statusPort), "a");
  const background = backgroundCommand(workflowPath, statusPort);
  const child = spawn(background.command, background.args, {
    cwd: process.cwd(),
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env
  });
  child.unref();
  writeFileSync(pidPath(statusPort), `${child.pid}\n`);

  const started = await waitForStatus(statusPort, 10000);
  if (!started) {
    throw new Error(`symphony_start_timeout: see ${logPath(statusPort)}`);
  }

  console.log(`Symphony started with pid ${child.pid}.`);
  console.log(`Status: http://127.0.0.1:${statusPort}/status`);
  console.log(`Log: ${logPath(statusPort)}`);
}

function backgroundCommand(workflowPath: string, statusPort: number): { command: string; args: string[] } {
  const entrypoint = entrypointPath();
  const runArgs = ["run", "--workflow", workflowPath, "--status-port", String(statusPort)];
  if (entrypoint.endsWith(".ts")) {
    return { command: "bun", args: ["run", "tsx", entrypoint, ...runArgs] };
  }
  return { command: process.execPath, args: [entrypoint, ...runArgs] };
}

async function runForeground(options: CliOptions): Promise<void> {
  const workflowPath = await resolveWorkflowPath(options.workflow);
  const statusPort = readStatusPort(options);
  const orchestrator = createDefaultOrchestrator(workflowPath);
  const statusServer = await startStatusServer(() => orchestrator.snapshot(), statusPort, {
    getEvents: (query) => orchestrator.events(query.issue, query.cursor, query.limit),
    queueSteer: (issue, text) => orchestrator.queueSteer(issue, text),
    resumeIssue: (issue) => orchestrator.resumeIssue(issue),
    resumeRateLimitedRuns: async () => {
      const resumed = orchestrator.resumeParkedRateLimitedRuns();
      await orchestrator.tick();
      return { resumed };
    }
  });

  const stop = async () => {
    logger.info("stopping symphony");
    statusServer.close();
    await orchestrator.stop();
    removePid(statusPort);
    process.exit(0);
  };

  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  logger.info({ workflowPath, statusPort }, "starting symphony");
  await orchestrator.start();
}

async function runLogsCommand(
  issue: string | null,
  options: { all?: boolean; follow?: boolean; json?: boolean; limit: string; interval: string },
  cliOptions: CliOptions
): Promise<void> {
  if (!issue && !options.all) {
    throw new Error("logs_requires_issue_or_all");
  }
  const port = readStatusPort(cliOptions);
  const limit = readPositiveInteger(options.limit, "limit");
  const intervalMs = readIntervalMs(options.interval);
  let cursor: number | null = null;
  const display = new StreamingEventDisplay();

  while (true) {
    const events = await fetchDaemonEvents(port, {
      issue: options.all ? null : issue,
      cursor,
      limit
    });
    if (!events) {
      console.log(`Symphony is not running on 127.0.0.1:${port}, or this runner does not support logs.`);
      return;
    }
    for (const event of events) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
      } else {
        for (const compacted of display.push(event)) {
          const formatted = options.all
            ? formatDisplayEvent(compacted, { includeIssue: event.identifier })
            : formatDisplayEvent(compacted);
          process.stdout.write(`${formatted}\n`);
        }
      }
      cursor = Math.max(cursor ?? 0, event.cursor);
    }
    if (!options.follow) {
      return;
    }
    await wait(intervalMs);
  }
}

async function stopBackground(options: CliOptions): Promise<void> {
  const statusPort = readStatusPort(options);
  const pid = readPid(statusPort);

  if (!pid) {
    if (!(await fetchDaemonStatus(statusPort))) {
      console.log(`Symphony is not running on 127.0.0.1:${statusPort}.`);
      return;
    }
    throw new Error(`missing_pid_file: ${pidPath(statusPort)}`);
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    removePid(statusPort);
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ESRCH") {
      console.log(`Removed stale Symphony pid file for pid ${pid}.`);
      return;
    }
    throw error;
  }

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!(await fetchDaemonStatus(statusPort)) && !isPidAlive(pid)) {
      removePid(statusPort);
      console.log(`Stopped Symphony pid ${pid}.`);
      return;
    }
    await wait(200);
  }

  throw new Error(`symphony_stop_timeout: pid ${pid}`);
}

function readStatusPort(options: CliOptions): number {
  const port = Number(options.statusPort);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`invalid_status_port: ${options.statusPort}`);
  }
  return port;
}

function readIntervalMs(value: string): number {
  const intervalMs = Number(value);
  if (!Number.isInteger(intervalMs) || intervalMs < 250) {
    throw new Error(`invalid_watch_interval: ${value}`);
  }
  return intervalMs;
}

function readPositiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid_${name}: ${value}`);
  }
  return parsed;
}

async function checkedRun(command: string, args: string[], cwd: string): Promise<void> {
  const result = await runCommand(command, args, { cwd, timeoutMs: 120000 });
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
  if (result.stdout.trim()) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.trim()) {
    process.stderr.write(result.stderr);
  }
}

function entrypointPath(): string {
  return fileURLToPath(import.meta.url);
}

function reexecInteractiveWatchWithBun(): boolean {
  if (process.versions.bun || process.env.SYMPHONY_BUN_REEXEC === "1" || !process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }
  const result = spawnSync("bun", [entrypointPath(), ...process.argv.slice(2)], {
    stdio: "inherit",
    env: {
      ...process.env,
      SYMPHONY_BUN_REEXEC: "1"
    }
  });
  if (result.error) {
    return false;
  }
  process.exitCode = result.status ?? 0;
  return true;
}

function packageRoot(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  while (current !== path.dirname(current)) {
    if (existsSync(path.join(current, "package.json"))) {
      return current;
    }
    current = path.dirname(current);
  }
  throw new Error("package_root_not_found");
}

function stateDir(): string {
  return path.join(os.homedir(), ".symphony");
}

function pidPath(port: number): string {
  return path.join(stateDir(), `symphony-${port}.pid`);
}

function logPath(port: number): string {
  return path.join(stateDir(), `symphony-${port}.log`);
}

function readPid(port: number): number | null {
  try {
    const pid = Number(readFileSync(pidPath(port), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function removePid(port: number): void {
  rmSync(pidPath(port), { force: true });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForStatus(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fetchDaemonStatus(port)) {
      return true;
    }
    await wait(200);
  }
  return false;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
