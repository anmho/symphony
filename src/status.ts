import http, { type Server } from "node:http";
import type { OrchestratorSnapshot } from "./types";

export const DEFAULT_STATUS_PORT = 3979;

export function startStatusServer(
  getSnapshot: () => OrchestratorSnapshot,
  port = DEFAULT_STATUS_PORT
): Promise<Server> {
  const server = http.createServer((request, response) => {
    if (request.url !== "/status") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(getSnapshot(), null, 2));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

export async function fetchDaemonStatus(port = DEFAULT_STATUS_PORT): Promise<OrchestratorSnapshot | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`);
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as OrchestratorSnapshot;
  } catch {
    return null;
  }
}
