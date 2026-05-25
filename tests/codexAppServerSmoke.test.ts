import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/process.js";
import {
  CODEX_APP_SERVER_SMOKE_CONTENT,
  CODEX_APP_SERVER_SMOKE_FILE,
  runCodexAppServerSmoke
} from "../src/codexAppServerSmoke.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("codex app-server capability smoke", () => {
  it("passes when the app-server edits a temporary workspace and emits command events", async () => {
    const { command } = await createFakeAppServer();

    const result = await runCodexAppServerSmoke({ command });

    expect(result.cleanedUp).toBe(true);
    expect(result.workspacePath).toContain("symphony-codex-app-server-smoke-");
    expect(result.commandEventCount).toBeGreaterThan(0);
    expect(result.commandOrToolEventCount).toBeGreaterThan(0);
    await expect(pathExists(result.workspacePath)).resolves.toBe(false);
  });

  it("exposes the smoke through the doctor CLI", async () => {
    const { command } = await createFakeAppServer();

    const result = await runCommand(
      "node",
      ["--import", "tsx", "src/index.ts", "doctor", "codex-app-server", "--command", command],
      { cwd: repoRoot, timeoutMs: 30000 }
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Codex app-server smoke passed.");
    expect(result.stdout).toContain("Temporary workspace cleaned up.");
  });

  it("prints clear doctor CLI failures", async () => {
    const { command } = await createFakeAppServer({ mode: "missingExperimentalApi" });

    const result = await runCommand(
      "node",
      ["--import", "tsx", "src/index.ts", "doctor", "codex-app-server", "--command", command],
      { cwd: repoRoot, timeoutMs: 30000 }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("codex_app_server_smoke_missing_experimental_api_support");
  });

  it("fails clearly when experimental API support is missing", async () => {
    const { command } = await createFakeAppServer({ mode: "missingExperimentalApi" });

    await expect(runCodexAppServerSmoke({ command })).rejects.toThrow(
      /codex_app_server_smoke_missing_experimental_api_support/
    );
  });

  it("fails clearly when the app-server cannot start", async () => {
    await expect(
      runCodexAppServerSmoke({ command: "printf 'missing runtime\\n' >&2; exit 127" })
    ).rejects.toThrow(/codex_app_server_smoke_app_server_startup_failed: [\s\S]*missing runtime/);
  });

  it("fails clearly when the turn does not execute tools successfully", async () => {
    const { command } = await createFakeAppServer({ mode: "turnFailed" });

    await expect(runCodexAppServerSmoke({ command })).rejects.toThrow(
      /codex_app_server_smoke_missing_tool_execution/
    );
  });

  it("fails clearly when sandbox writes do not land", async () => {
    const { command } = await createFakeAppServer({ mode: "noFileWrite" });

    await expect(runCodexAppServerSmoke({ command })).rejects.toThrow(
      /codex_app_server_smoke_sandbox_write_failed/
    );
  });

  it("fails clearly when command or tool events are absent", async () => {
    const { command } = await createFakeAppServer({ mode: "noCommandEvents" });

    await expect(runCodexAppServerSmoke({ command })).rejects.toThrow(
      /codex_app_server_smoke_absent_command_tool_events/
    );
  });

  it("reports the temporary workspace path when cleanup fails", async () => {
    const { command } = await createFakeAppServer();

    await expect(
      runCodexAppServerSmoke({
        command,
        removeTempWorkspace: async () => {
          throw new Error("forced cleanup failure");
        }
      })
    ).rejects.toThrow(/codex_app_server_smoke_cleanup_failed: .*symphony-codex-app-server-smoke-/);
  });
});

type FakeAppServerMode =
  | "success"
  | "missingExperimentalApi"
  | "turnFailed"
  | "noFileWrite"
  | "noCommandEvents";

async function createFakeAppServer(
  options: { mode?: FakeAppServerMode } = {}
): Promise<{ command: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "symphony-fake-smoke-server-"));
  const serverPath = path.join(dir, "server.mjs");
  await mkdir(path.join(dir, "unused"), { recursive: true });
  await writeFile(
    serverPath,
    fakeAppServerSource({
      mode: options.mode ?? "success",
      fileName: CODEX_APP_SERVER_SMOKE_FILE,
      fileContent: CODEX_APP_SERVER_SMOKE_CONTENT
    })
  );
  return {
    command: `node ${shellQuote(serverPath)}`
  };
}

function fakeAppServerSource(input: {
  mode: FakeAppServerMode;
  fileName: string;
  fileContent: string;
}): string {
  return `
import { writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const mode = ${JSON.stringify(input.mode)};
const fileName = ${JSON.stringify(input.fileName)};
const fileContent = ${JSON.stringify(input.fileContent)};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);

  if (message.method === "initialize") {
    if (mode === "missingExperimentalApi") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "experimental API support is not enabled" }
      });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-smoke" } } });
    return;
  }

  if (message.method === "thread/goal/set") {
    send({ jsonrpc: "2.0", id: message.id, result: { goal: { status: "active" } } });
    return;
  }

  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-smoke", status: "running" } } });

    if (mode !== "noCommandEvents") {
      send({
        jsonrpc: "2.0",
        method: "item/completed",
        params: {
          item: {
            type: "command_execution",
            command: "printf smoke > " + fileName,
            status: mode === "noFileWrite" || mode === "turnFailed" ? "failed" : "completed"
          }
        }
      });
    }

    if (mode !== "noFileWrite") {
      writeFileSync(path.join(message.params.cwd, fileName), fileContent);
    }

    send({
      jsonrpc: "2.0",
      method: "turn/completed",
      params: { threadId: message.params.threadId, turn: { id: "turn-smoke", status: mode === "turnFailed" ? "failed" : "completed" } }
    });
    return;
  }

  send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "unsupported" } });
});
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await access(value);
    return true;
  } catch {
    return false;
  }
}
